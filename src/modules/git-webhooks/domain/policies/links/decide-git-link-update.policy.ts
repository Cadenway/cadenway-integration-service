import { InvalidGitLinkError } from '../../errors/links/invalid-git-link.error.js';
import type { GitLinkChanged } from '../../events/links/git-link-changed.event.js';
import type { GitChecksEvidence } from '../../value-objects/checks/git-checks-evidence.value-object.js';
import type { GitLinkDecision } from '../../value-objects/links/git-link-decision.value-object.js';
import type { GitLinkDelivery } from '../../value-objects/links/git-link-delivery.value-object.js';
import type { GitLinkMemberName } from '../../value-objects/links/git-link-member-name.value-object.js';
import type { GitLinkMembers } from '../../value-objects/links/git-link-members.value-object.js';
import type { GitLinkProjection } from '../../value-objects/links/git-link-projection.value-object.js';
import { aggregateGitChecks } from '../checks/aggregate-git-checks.policy.js';

type Status = GitLinkProjection['status'];
type Lifecycle = 'unchanged' | 'applied' | 'tie';

const lifecycleFacts = {
  open: 'pull-request-reopened',
  closed: 'pull-request-closed',
  merged: 'pull-request-merged',
} as const;

/**
 * Applies one verified delivery to one link under "Ordering", "Checks" and "Reconciliation" of
 * the Integration AsyncAPI, for the Development panel (App.dc.html:4328–4360).
 *
 * - The lifecycle and every other member keep their own provider-time watermark. An older
 *   delivery is ignored for that member; an equal one is applied in admission order, which the
 *   watermark keeps, even when the Task call lets a later-admitted delivery settle first.
 * - `merged` is final: a verified merge supersedes `closed` whatever its time, and nothing
 *   leaves `merged`. A delivery that reports another state realigns the lifecycle when it is
 *   not older than the last one applied. An equal-time delivery whose lifecycle differs marks
 *   the link for reconciliation, whether it is applied or ignored; a strictly newer delivery that
 *   carries the state clears the mark.
 * - Checks are the aggregate of `evidenceOf(headSha)` for the current head, recomputed on
 *   creation, on a head change and on a check observation of that head.
 * - Every committed change takes the next version and one fact: the lifecycle fact, the check
 *   completion, or `link-updated` naming the other changed members. A creation that finds
 *   stored observations adds a `link-updated` naming `checks` after its opening fact.
 *
 * Returns null when the delivery cannot create a missing link.
 */
export function decideGitLinkUpdate(
  current: GitLinkProjection | null,
  delivery: GitLinkDelivery,
  evidenceOf: (headSha: string) => GitChecksEvidence | null,
): GitLinkDecision | null {
  if (current === null) return delivery.creates ? create(delivery, evidenceOf) : null;
  if ((current.status === 'created') !== (delivery.kind === 'branch')) {
    throw new InvalidGitLinkError();
  }
  assertVersion(current.version);

  const lifecycle = delivery.kind === 'branch' ? null : applyLifecycle(current, delivery);
  const members = applyMembers(current, delivery);
  const head = applyHead(current, delivery);
  const headChanged = head.sha !== current.head?.sha;
  const recompute = head.sha !== undefined && (headChanged || delivery.checksHeadSha === head.sha);
  const evidence = recompute ? evidenceOf(head.sha) : null;
  // A check receipt admitted by the previous release has no stored observation: it only
  // advances the completion time, as that release did.
  const legacy = delivery.legacyChecksCompletedAtMs;
  const legacyCompletion =
    recompute &&
    !headChanged &&
    evidence === null &&
    legacy !== null &&
    legacy > (current.checksCompletedAtMs ?? -1);
  const aggregate = !recompute
    ? { checks: current.checks, completedAtMs: current.checksCompletedAtMs }
    : legacyCompletion
      ? { checks: current.checks, completedAtMs: legacy }
      : evidence === null && legacy !== null && !headChanged
        ? { checks: current.checks, completedAtMs: current.checksCompletedAtMs }
        : aggregateGitChecks(evidence);
  const checksChanged = !same(aggregate.checks, current.checks);
  const completedChanged = aggregate.completedAtMs !== current.checksCompletedAtMs;

  const changes: GitLinkChanged[] = [];
  let version = current.version;
  const next = (): number => {
    version += 1;
    assertVersion(version);
    return version;
  };
  const status = lifecycle?.status ?? current.status;
  if (status !== current.status) {
    changes.push({ type: lifecycleFacts[status as keyof typeof lifecycleFacts], version: next() });
  }

  const memberNames: string[] = [...members.changed];
  if (headChanged) memberNames.push('headSha');
  const checkNames: string[] = [];
  if (checksChanged) checkNames.push('checks');
  if (completedChanged) checkNames.push('checksCompletedAt');
  const entersOutcome =
    delivery.checksHeadSha !== null &&
    !headChanged &&
    aggregate.checks !== null &&
    aggregate.checks.state !== 'running' &&
    aggregate.checks.state !== current.checks?.state;
  if (entersOutcome || legacyCompletion) {
    changes.push({ type: 'checks-completed', version: next() });
  } else if (changes.length === 0 && memberNames.length + checkNames.length !== 0) {
    changes.push({
      type: 'link-updated',
      version: next(),
      changed: [...memberNames, ...checkNames],
    });
  } else if (checkNames.length !== 0) {
    // A lifecycle fact covers the other members of its delivery, not the aggregate.
    const changed = headChanged ? ['headSha', ...checkNames] : checkNames;
    changes.push({ type: 'link-updated', version: next(), changed });
  }

  const tie = lifecycle?.result === 'tie';
  const cleared = lifecycle?.clears === true && !tie;
  const reconciliationPending = tie || (current.reconciliationPending && !cleared);
  return {
    projection: {
      status,
      version,
      lifecycleObservedAtMs: lifecycle?.observedAtMs ?? current.lifecycleObservedAtMs,
      lifecycleAdmissionSequence:
        lifecycle?.admissionSequence ?? current.lifecycleAdmissionSequence,
      members: members.values,
      memberObservedAtMs: members.observedAtMs,
      memberAdmissionSequence: members.admissionSequence,
      linkSource: current.linkSource,
      head: head.value,
      checks: aggregate.checks,
      checksCompletedAtMs: aggregate.completedAtMs,
      reconciliationPending,
    },
    events: changes,
    reconciliation:
      reconciliationPending === current.reconciliationPending
        ? 'unchanged'
        : reconciliationPending
          ? 'marked'
          : 'cleared',
  };
}

function create(
  delivery: GitLinkDelivery,
  evidenceOf: (headSha: string) => GitChecksEvidence | null,
): GitLinkDecision {
  const state = delivery.lifecycle?.state;
  if (delivery.kind === 'pull-request' && state !== 'open' && state !== 'merged') {
    throw new InvalidGitLinkError();
  }
  const status: Status = delivery.kind === 'branch' ? 'created' : (state ?? 'open');
  const head =
    delivery.kind === 'branch' || delivery.head === null
      ? null
      : {
          sha: delivery.head.sha,
          firstObservedAtMs: delivery.head.observedAtMs,
          lastObservedAtMs: delivery.head.observedAtMs,
          admissionSequence: delivery.admissionSequence,
        };
  const memberObservedAtMs: Partial<Record<GitLinkMemberName, number>> = {};
  const memberAdmissionSequence: Partial<Record<GitLinkMemberName, number>> = {};
  if (delivery.membersObservedAtMs !== null) {
    for (const name of Object.keys(delivery.members) as GitLinkMemberName[]) {
      memberObservedAtMs[name] = delivery.membersObservedAtMs;
      memberAdmissionSequence[name] = delivery.admissionSequence;
    }
  }
  const aggregate =
    head === null
      ? { checks: null, completedAtMs: null }
      : aggregateGitChecks(evidenceOf(head.sha));
  const events: GitLinkChanged[] = [
    {
      type:
        status === 'created'
          ? 'branch-created'
          : status === 'merged'
            ? 'pull-request-merged'
            : 'pull-request-opened',
      version: 1,
    },
  ];
  const checkNames: string[] = [];
  if (aggregate.checks !== null) checkNames.push('checks');
  if (aggregate.completedAtMs !== null) checkNames.push('checksCompletedAt');
  if (checkNames.length !== 0)
    events.push({ type: 'link-updated', version: 2, changed: checkNames });
  return {
    projection: {
      status,
      version: events.length,
      lifecycleObservedAtMs:
        delivery.kind === 'branch' ? null : (delivery.lifecycle?.observedAtMs ?? null),
      lifecycleAdmissionSequence: delivery.admissionSequence,
      members: delivery.members,
      memberObservedAtMs,
      memberAdmissionSequence,
      linkSource: delivery.linkSource,
      head,
      checks: aggregate.checks,
      checksCompletedAtMs: aggregate.completedAtMs,
      reconciliationPending: false,
    },
    events,
    reconciliation: 'unchanged',
  };
}

/**
 * Orders a delivery against a watermark: provider time first, then admission order, since the
 * Task call before settlement can let a later-admitted delivery settle first. The same admission
 * is the same delivery.
 */
function order(
  at: number,
  sequence: number,
  watermark: number,
  watermarkSequence: number,
): 'newer' | 'later' | 'same' | 'earlier' | 'older' {
  if (at !== watermark) return at > watermark ? 'newer' : 'older';
  if (sequence === watermarkSequence) return 'same';
  return sequence > watermarkSequence ? 'later' : 'earlier';
}

/** Orders the lifecycle on its own watermark. A merge is final and supersedes a closure. */
function applyLifecycle(
  current: GitLinkProjection,
  delivery: GitLinkDelivery,
): {
  readonly status: Status;
  readonly observedAtMs: number | null;
  readonly admissionSequence: number;
  readonly result: Lifecycle;
  readonly clears: boolean;
} | null {
  const reported = delivery.lifecycle;
  if (reported === null) return null;
  const watermark = current.lifecycleObservedAtMs;
  const at = reported.observedAtMs;
  const differs = reported.state !== current.status;
  const kept = {
    observedAtMs: watermark,
    admissionSequence: current.lifecycleAdmissionSequence,
  };
  if (at === null) {
    // Without a provider time a delivery can only fill a lifecycle that was never ordered.
    const fills = watermark === null && differs && current.status !== 'merged';
    return {
      status: fills || reported.state === 'merged' ? reported.state : current.status,
      ...kept,
      result: fills || (reported.state === 'merged' && differs) ? 'applied' : 'unchanged',
      clears: false,
    };
  }
  const position =
    watermark === null
      ? 'newer'
      : order(at, delivery.admissionSequence, watermark, current.lifecycleAdmissionSequence);
  const advances = position === 'newer' || position === 'later';
  const next = advances
    ? { observedAtMs: at, admissionSequence: delivery.admissionSequence }
    : kept;
  // An equal-time delivery that another delivery of the same time disagrees with is ambiguous.
  const tie = (position === 'later' || position === 'earlier') && differs;
  const clears = position === 'newer';

  if (current.status === 'merged') {
    return { status: 'merged', ...next, result: tie ? 'tie' : 'unchanged', clears };
  }
  if (reported.state === 'merged') {
    return { status: 'merged', ...next, result: tie ? 'tie' : 'applied', clears };
  }
  if (advances && differs) {
    return { status: reported.state, ...next, result: tie ? 'tie' : 'applied', clears };
  }
  return { status: current.status, ...next, result: tie ? 'tie' : 'unchanged', clears };
}

/** Applies each carried member on its own watermark, in admission order for an equal time. */
function applyMembers(
  current: GitLinkProjection,
  delivery: GitLinkDelivery,
): {
  readonly values: GitLinkMembers;
  readonly observedAtMs: Readonly<Partial<Record<GitLinkMemberName, number>>>;
  readonly admissionSequence: Readonly<Partial<Record<GitLinkMemberName, number>>>;
  readonly changed: readonly GitLinkMemberName[];
} {
  const values: Record<string, unknown> = { ...current.members };
  const observedAtMs: Partial<Record<GitLinkMemberName, number>> = {
    ...current.memberObservedAtMs,
  };
  const admissionSequence: Partial<Record<GitLinkMemberName, number>> = {
    ...current.memberAdmissionSequence,
  };
  const changed: GitLinkMemberName[] = [];
  const at = delivery.membersObservedAtMs;
  for (const [name, value] of Object.entries(delivery.members) as [GitLinkMemberName, unknown][]) {
    const watermark = observedAtMs[name];
    const recorded = values[name];
    const position =
      at === null || watermark === undefined
        ? null
        : order(at, delivery.admissionSequence, watermark, admissionSequence[name] ?? 0);
    const applies =
      at === null
        ? recorded === undefined
        : position === null || position === 'newer' || position === 'later' || position === 'same';
    if (!applies) continue;
    if (at !== null) {
      observedAtMs[name] = at;
      admissionSequence[name] = delivery.admissionSequence;
    }
    if (!same(value, recorded)) {
      values[name] = value;
      changed.push(name);
    }
  }
  return { values, observedAtMs, admissionSequence, changed };
}

/** Applies a head observed at or after the last one, in admission order for an equal time. */
function applyHead(
  current: GitLinkProjection,
  delivery: GitLinkDelivery,
): { readonly value: GitLinkProjection['head']; readonly sha: string | undefined } {
  const observed = delivery.head;
  const recorded = current.head;
  if (delivery.kind === 'branch' || observed === null) {
    return { value: recorded, sha: recorded?.sha };
  }
  if (recorded !== null) {
    const position = order(
      observed.observedAtMs,
      delivery.admissionSequence,
      recorded.lastObservedAtMs,
      recorded.admissionSequence,
    );
    if (position === 'older' || position === 'earlier') {
      return { value: recorded, sha: recorded.sha };
    }
    if (recorded.sha === observed.sha) {
      const value = {
        ...recorded,
        lastObservedAtMs: observed.observedAtMs,
        admissionSequence: delivery.admissionSequence,
      };
      return { value, sha: value.sha };
    }
  }
  const value = {
    sha: observed.sha,
    firstObservedAtMs: observed.observedAtMs,
    lastObservedAtMs: observed.observedAtMs,
    admissionSequence: delivery.admissionSequence,
  };
  return { value, sha: value.sha };
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new InvalidGitLinkError();
}

/** Compares member values regardless of the key order a JSON store gives back. */
function same(first: unknown, second: unknown): boolean {
  return canonical(first) === canonical(second);
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`).join(',')}}`;
}
