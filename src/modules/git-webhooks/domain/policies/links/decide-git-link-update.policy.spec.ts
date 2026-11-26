import { describe, expect, it } from 'vitest';

import { InvalidGitLinkError } from '../../errors/links/invalid-git-link.error.js';
import type { GitCheckObservation } from '../../value-objects/checks/git-check-observation.value-object.js';
import type { GitChecksEvidence } from '../../value-objects/checks/git-checks-evidence.value-object.js';
import type { GitLinkDelivery } from '../../value-objects/links/git-link-delivery.value-object.js';
import type { GitLinkProjection } from '../../value-objects/links/git-link-projection.value-object.js';
import { decideGitLinkUpdate } from './decide-git-link-update.policy.js';

const T = Date.UTC(2026, 10, 8, 10, 41);
const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);

function request(overrides: Partial<GitLinkDelivery> = {}): GitLinkDelivery {
  return {
    kind: 'pull-request',
    creates: false,
    admissionSequence: 0,
    lifecycle: null,
    members: {},
    membersObservedAtMs: null,
    head: null,
    checksHeadSha: null,
    legacyChecksCompletedAtMs: null,
    linkSource: null,
    ...overrides,
  };
}

const opening = request({
  creates: true,
  lifecycle: { state: 'open', observedAtMs: T - 60_000 },
  members: { title: 'feat(auth): unified SSO sign-in screen', draft: true },
  membersObservedAtMs: T - 60_000,
  head: { sha: headA, observedAtMs: T - 60_000 },
  linkSource: 'branch',
});
const close = (at: number): GitLinkDelivery =>
  request({ lifecycle: { state: 'closed', observedAtMs: at } });
const reopen = (at: number): GitLinkDelivery =>
  request({ lifecycle: { state: 'open', observedAtMs: at } });
const merge = (at: number): GitLinkDelivery =>
  request({ creates: true, lifecycle: { state: 'merged', observedAtMs: at } });

function suite(
  attemptId: number,
  status: 'queued' | 'completed',
  conclusion: string | null,
  at: number,
  headSha = headA,
): GitCheckObservation {
  return {
    provider: 'github',
    attemptId,
    headSha,
    observedAtMs: at,
    completedAtMs: status === 'completed' ? at : null,
    status,
    conclusion,
  };
}

/** Summarizes observations as the observation store does in SQL. */
function evidence(observations: readonly GitCheckObservation[]): GitChecksEvidence | null {
  const [first] = observations;
  if (first === undefined) return null;
  if (first.provider === 'gitlab') {
    const pipelines = observations.filter((observation) => observation.provider === 'gitlab');
    const latest = pipelines.reduce((a, b) => (b.attemptId > a.attemptId ? b : a));
    const completed = pipelines.flatMap(({ completedAtMs }) =>
      completedAtMs === null ? [] : [completedAtMs],
    );
    return {
      provider: 'gitlab',
      latest,
      completedAtMs: completed.length === 0 ? null : Math.max(...completed),
    };
  }
  return {
    provider: 'github',
    suites: observations.flatMap((observation) =>
      observation.provider === 'github'
        ? [
            {
              status: observation.status,
              conclusion: observation.conclusion,
              count: 1,
              completedAtMs: observation.completedAtMs,
            },
          ]
        : [],
    ),
  };
}

/** Applies deliveries in arrival order, as the dispatch transaction does. */
function replay(
  deliveries: readonly GitLinkDelivery[],
  observations: Readonly<Record<string, readonly GitCheckObservation[]>> = {},
): { readonly projection: GitLinkProjection | null; readonly facts: string[] } {
  let projection: GitLinkProjection | null = null;
  const facts: string[] = [];
  for (const [index, arrived] of deliveries.entries()) {
    // Unless a test sets it, deliveries are admitted in the order they arrive.
    const delivery =
      arrived.admissionSequence === 0 ? { ...arrived, admissionSequence: index + 1 } : arrived;
    const decision = decideGitLinkUpdate(projection, delivery, (sha) =>
      evidence(observations[sha] ?? []),
    );
    if (decision === null) continue;
    projection = decision.projection;
    for (const event of decision.events) {
      facts.push(
        event.type === 'link-updated'
          ? `v${String(event.version)} link-updated ${event.changed.join(',')}`
          : `v${String(event.version)} ${event.type}`,
      );
    }
  }
  return { projection, facts };
}

describe('Git link ordering and reconciliation', () => {
  it('creates CAD-482 with its members, head and version 1', () => {
    const { projection, facts } = replay([opening]);
    expect(facts).toEqual(['v1 pull-request-opened']);
    expect(projection).toMatchObject({
      status: 'open',
      version: 1,
      members: { title: 'feat(auth): unified SSO sign-in screen', draft: true },
      memberObservedAtMs: { title: T - 60_000, draft: T - 60_000 },
      linkSource: 'branch',
      head: { sha: headA },
      checks: null,
      reconciliationPending: false,
    });
  });

  it('only updates an existing link for a delivery that cannot create it', () => {
    expect(decideGitLinkUpdate(null, close(T), () => null)).toBeNull();
  });

  it('closes then reopens at the same provider time and marks the tie', () => {
    const { projection, facts } = replay([opening, close(T), reopen(T)]);
    expect(facts).toEqual([
      'v1 pull-request-opened',
      'v2 pull-request-closed',
      'v3 pull-request-reopened',
    ]);
    expect(projection).toMatchObject({ status: 'open', reconciliationPending: true });
  });

  it('reopens then closes at the same provider time, then realigns from the next delivery', () => {
    const tied = replay([opening, close(T - 1_000), reopen(T), close(T)]);
    expect(tied.facts.slice(-2)).toEqual(['v3 pull-request-reopened', 'v4 pull-request-closed']);
    expect(tied.projection).toMatchObject({ status: 'closed', reconciliationPending: true });

    const synchronizedAtT = replay([opening, close(T - 1_000), reopen(T), close(T), reopen(T)]);
    expect(synchronizedAtT.facts.at(-1)).toBe('v5 pull-request-reopened');
    expect(synchronizedAtT.projection?.reconciliationPending).toBe(true);

    const newer = replay([opening, close(T - 1_000), reopen(T), close(T), reopen(T + 1_000)]);
    expect(newer.facts.at(-1)).toBe('v5 pull-request-reopened');
    expect(newer.projection).toMatchObject({ status: 'open', reconciliationPending: false });
  });

  it('clears the mark with a strictly newer delivery that carries the recorded state', () => {
    const { projection, facts } = replay([opening, close(T), reopen(T), reopen(T + 1_000)]);
    expect(facts).toHaveLength(3);
    expect(projection).toMatchObject({
      status: 'open',
      lifecycleObservedAtMs: T + 1_000,
      reconciliationPending: false,
    });
  });

  it('ignores an older lifecycle delivery without marking the link', () => {
    const { projection, facts } = replay([opening, close(T), reopen(T - 1_000)]);
    expect(facts.at(-1)).toBe('v2 pull-request-closed');
    expect(projection).toMatchObject({ status: 'closed', reconciliationPending: false });
  });

  it('keeps a merge final and marks an equal-time close it ignores', () => {
    const { projection, facts } = replay([opening, merge(T), close(T), reopen(T + 5_000)]);
    expect(facts).toEqual(['v1 pull-request-opened', 'v2 pull-request-merged']);
    expect(projection?.status).toBe('merged');
    const tie = replay([opening, merge(T), close(T)]);
    expect(tie.projection?.reconciliationPending).toBe(true);
  });

  it('lets a verified merge supersede a newer closure', () => {
    const { projection, facts } = replay([opening, close(T), merge(T - 5_000)]);
    expect(facts.at(-1)).toBe('v3 pull-request-merged');
    expect(projection?.status).toBe('merged');
  });

  it('publishes the merge once when it arrives after a realignment to merged', () => {
    const realigned = request({
      lifecycle: { state: 'merged', observedAtMs: T },
      members: { additions: 418, deletions: 132 },
      membersObservedAtMs: T,
    });
    const { projection, facts } = replay([
      opening,
      realigned,
      request({
        lifecycle: { state: 'merged', observedAtMs: T },
        members: { title: 'feat(auth): SSO sign-in' },
        membersObservedAtMs: T,
      }),
    ]);
    expect(facts).toEqual([
      'v1 pull-request-opened',
      'v2 pull-request-merged',
      'v3 link-updated title',
    ]);
    expect(projection).toMatchObject({ status: 'merged', reconciliationPending: false });
  });
});

describe('Git link admission order', () => {
  it('keeps two same-second updates in admission order when their Task calls finish reversed', () => {
    const update = (sequence: number, title: string, sha: string): GitLinkDelivery =>
      request({
        admissionSequence: sequence,
        members: { title },
        membersObservedAtMs: T,
        head: { sha, observedAtMs: T },
      });
    const { projection, facts } = replay([
      { ...opening, admissionSequence: 1 },
      update(3, 'Admitted second', headB),
      update(2, 'Admitted first', headA),
    ]);
    expect(facts).toEqual(['v1 pull-request-opened', 'v2 link-updated title,headSha']);
    expect(projection).toMatchObject({
      members: { title: 'Admitted second' },
      head: { sha: headB, admissionSequence: 3 },
    });
  });

  it('keeps a reopen admitted after an equal-time close that settles later, and marks the tie', () => {
    const { projection, facts } = replay([
      { ...opening, admissionSequence: 1 },
      { ...close(T - 1_000), admissionSequence: 2 },
      { ...reopen(T), admissionSequence: 4 },
      { ...close(T), admissionSequence: 3 },
    ]);
    expect(facts).toEqual([
      'v1 pull-request-opened',
      'v2 pull-request-closed',
      'v3 pull-request-reopened',
    ]);
    expect(projection).toMatchObject({
      status: 'open',
      lifecycleAdmissionSequence: 4,
      reconciliationPending: true,
    });
  });

  it('ignores the same delivery settled twice', () => {
    const { projection, facts } = replay([
      { ...opening, admissionSequence: 1 },
      { ...close(T), admissionSequence: 2 },
      { ...close(T), admissionSequence: 2 },
    ]);
    expect(facts).toHaveLength(2);
    expect(projection?.reconciliationPending).toBe(false);
  });
});

describe('Git link members', () => {
  it('applies each member on its own watermark, in arrival order at an equal time', () => {
    const edit = (title: string, at: number): GitLinkDelivery =>
      request({ members: { title }, membersObservedAtMs: at });
    const { projection, facts } = replay([
      opening,
      edit('Second title', T),
      edit('Stale title', T - 30_000),
      edit('Tied title', T),
      request({ members: { draft: false, reviewRequested: true }, membersObservedAtMs: T - 1 }),
    ]);
    expect(facts).toEqual([
      'v1 pull-request-opened',
      'v2 link-updated title',
      'v3 link-updated title',
      'v4 link-updated draft,reviewRequested',
    ]);
    expect(projection?.members).toEqual({
      title: 'Tied title',
      draft: false,
      reviewRequested: true,
    });
  });

  it('publishes nothing for a delivery that changes nothing', () => {
    const decision = decideGitLinkUpdate(
      replay([opening]).projection,
      request({ members: { draft: true }, membersObservedAtMs: T }),
      () => null,
    );
    expect(decision?.events).toEqual([]);
    expect(decision?.projection.memberObservedAtMs.draft).toBe(T);
  });

  it('lets a lifecycle fact cover the other members of its delivery', () => {
    const { facts } = replay([
      opening,
      request({
        lifecycle: { state: 'closed', observedAtMs: T },
        members: { title: 'Closed title' },
        membersObservedAtMs: T,
        head: { sha: headB, observedAtMs: T },
      }),
    ]);
    expect(facts.at(-1)).toBe('v2 pull-request-closed');
  });

  it('refuses a branch projection for a request delivery and an exhausted version', () => {
    const branch = replay([
      { ...request({ creates: true }), kind: 'branch', lifecycle: null },
    ]).projection;
    expect(branch?.status).toBe('created');
    expect(() => decideGitLinkUpdate(branch, close(T), () => null)).toThrow(InvalidGitLinkError);
    const open = replay([opening]).projection;
    if (open === null) throw new Error('missing projection');
    expect(() =>
      decideGitLinkUpdate({ ...open, version: Number.MAX_SAFE_INTEGER }, close(T), () => null),
    ).toThrow(InvalidGitLinkError);
  });
});

describe('Git link checks', () => {
  const checks = (headSha: string): GitLinkDelivery => request({ checksHeadSha: headSha });

  it('finds checks stored before the link existed and announces them after the opening', () => {
    const { projection, facts } = replay([opening], {
      [headA]: [suite(315, 'completed', 'success', T - 120_000)],
    });
    expect(facts).toEqual(['v1 pull-request-opened', 'v2 link-updated checks,checksCompletedAt']);
    expect(projection).toMatchObject({
      version: 2,
      checks: { state: 'passed', total: 1, failed: 0 },
      checksCompletedAtMs: T - 120_000,
    });
  });

  it('recomputes checks stored before the head update when the head becomes current', () => {
    const { projection, facts } = replay(
      [opening, request({ head: { sha: headB, observedAtMs: T } })],
      { [headB]: [suite(316, 'completed', 'failure', T - 1_000, headB)] },
    );
    expect(facts.at(-1)).toBe('v2 link-updated headSha,checks,checksCompletedAt');
    expect(projection).toMatchObject({
      head: { sha: headB, firstObservedAtMs: T },
      checks: { state: 'failed', total: 1, failed: 1 },
    });
  });

  it('ignores a head older than the current one and drops checks of a replaced head', () => {
    const { projection, facts } = replay(
      [opening, request({ head: { sha: headB, observedAtMs: T - 120_000 } })],
      { [headA]: [suite(315, 'queued', null, T - 60_000)] },
    );
    expect(facts).toEqual(['v1 pull-request-opened', 'v2 link-updated checks']);
    expect(projection?.head?.sha).toBe(headA);
  });

  it('publishes a check completion when the aggregate enters passed', () => {
    const observations: Record<string, GitCheckObservation[]> = {
      [headA]: [suite(315, 'queued', null, T)],
    };
    const first = replay([opening], observations);
    observations[headA] = [suite(315, 'completed', 'success', T + 60_000)];
    const decision = decideGitLinkUpdate(first.projection, checks(headA), (sha) =>
      evidence(sha === headA ? (observations[headA] ?? []) : []),
    );
    expect(decision?.events).toEqual([{ type: 'checks-completed', version: 3 }]);
  });

  it('leaves checks absent when the only suite became stale', () => {
    const first = replay([opening], { [headA]: [suite(315, 'queued', null, T)] });
    const decision = decideGitLinkUpdate(first.projection, checks(headA), () =>
      evidence([suite(315, 'completed', 'stale', T + 60_000)]),
    );
    expect(decision?.projection.checks).toBeNull();
    expect(decision?.events).toEqual([{ type: 'link-updated', version: 3, changed: ['checks'] }]);
  });

  it('announces a later completion time without an aggregate change', () => {
    const pipeline = (attemptId: number, at: number): GitCheckObservation => ({
      provider: 'gitlab',
      attemptId,
      headSha: headA,
      observedAtMs: at,
      completedAtMs: at,
      status: 'success',
      jobTotal: 3,
      jobFailed: 0,
    });
    const first = replay([opening], { [headA]: [pipeline(31, T)] });
    expect(first.projection?.checks).toEqual({ state: 'passed', total: 3, failed: 0 });
    const decision = decideGitLinkUpdate(first.projection, checks(headA), () =>
      evidence([pipeline(31, T), pipeline(32, T + 60_000)]),
    );
    expect(decision?.events).toEqual([
      { type: 'link-updated', version: 3, changed: ['checksCompletedAt'] },
    ]);
    expect(decision?.projection.checksCompletedAtMs).toBe(T + 60_000);
  });

  it('advances the completion of a previous-release check receipt that has no observation', () => {
    const first = replay([opening]);
    const legacy = request({ checksHeadSha: headA, legacyChecksCompletedAtMs: T + 60_000 });
    const decision = decideGitLinkUpdate(first.projection, legacy, () => null);
    expect(decision?.events).toEqual([{ type: 'checks-completed', version: 2 }]);
    expect(decision?.projection).toMatchObject({ checks: null, checksCompletedAtMs: T + 60_000 });
    expect(decideGitLinkUpdate(decision?.projection ?? null, legacy, () => null)?.events).toEqual(
      [],
    );
  });

  it('uses stored observations over the fields of a previous-release receipt', () => {
    const first = replay([opening]);
    const legacy = request({ checksHeadSha: headA, legacyChecksCompletedAtMs: T + 60_000 });
    const decision = decideGitLinkUpdate(first.projection, legacy, () =>
      evidence([suite(315, 'completed', 'failure', T + 30_000)]),
    );
    expect(decision?.projection).toMatchObject({
      checks: { state: 'failed', total: 1, failed: 1 },
      checksCompletedAtMs: T + 30_000,
    });
  });

  it('changes nothing for checks of a head that is not the link head', () => {
    const first = replay([opening]);
    const decision = decideGitLinkUpdate(first.projection, checks(headB), () =>
      evidence([suite(316, 'completed', 'success', T, headB)]),
    );
    expect(decision?.events).toEqual([]);
    expect(decision?.projection.checks).toBeNull();
  });
});
