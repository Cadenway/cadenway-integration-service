import { InvalidGitLinkError } from '../../errors/links/invalid-git-link.error.js';
import type { VerifiedGitDelivery } from '../../value-objects/deliveries/verified-git-delivery.value-object.js';
import type { GitLinkDelivery } from '../../value-objects/links/git-link-delivery.value-object.js';
import type { GitLinkIdentity } from '../../value-objects/links/git-link-identity.value-object.js';

type LinkScope = Pick<GitLinkIdentity, 'organizationId' | 'receiverId' | 'binding' | 'taskId'>;
/** A delivery about one link; `head_checks` is first split into one `pr_checks` per link. */
type LinkReference = Exclude<
  Extract<VerifiedGitDelivery, { kind: 'actionable' }>,
  { trigger: 'head_checks' }
>;

const triggerStates = {
  pr_open: 'open',
  pr_reopened: 'open',
  pr_closed: 'closed',
  pr_merged: 'merged',
} as const;

/**
 * Identifies an authorized link as shown in the Development panel (App.dc.html:4328–4360).
 * A branch retains its exact ref, while a request keeps the same identity as its state changes.
 */
export function gitLinkIdentity(scope: LinkScope, reference: LinkReference): GitLinkIdentity {
  const { organizationId, receiverId, binding, taskId } = scope;
  if (reference.trigger === 'branch') {
    if (reference.branch.length === 0) throw new InvalidGitLinkError();
    return { organizationId, receiverId, binding, taskId, kind: 'branch', ref: reference.branch };
  }

  const { requestNumber } = reference;
  if (
    !Number.isSafeInteger(requestNumber) ||
    requestNumber < 1 ||
    (reference.trigger === 'pr_checks' && reference.checks.requestNumber !== requestNumber)
  ) {
    throw new InvalidGitLinkError();
  }
  return { organizationId, receiverId, binding, taskId, kind: 'pull-request', requestNumber };
}

/**
 * Reads what a verified delivery contributes to the link of one task. A branch creation, an
 * opening and a merge that cites the task can create the link; an inferred task only updates an
 * existing one (MODULE.md invariants). Lifecycle actions carry their own state; an update, a
 * GitLab merge request pipeline and the request snapshot report the request's current state,
 * which realigns the link ("Reconciliation", Integration AsyncAPI).
 */
export function gitLinkDeliveryOf(
  reference: LinkReference,
  taskKey: string,
  admissionSequence = 0,
): GitLinkDelivery {
  return { ...contribution(reference, taskKey), admissionSequence };
}

function contribution(
  reference: LinkReference,
  taskKey: string,
): Omit<GitLinkDelivery, 'admissionSequence'> {
  const linkSource = reference.linkSources?.[taskKey] ?? null;
  if (reference.trigger === 'branch') {
    return {
      kind: 'branch',
      creates: true,
      lifecycle: null,
      verifiedMerge: false,
      members: reference.members ?? {},
      membersObservedAtMs: null,
      head: null,
      checksHeadSha: null,
      legacyChecksCompletedAtMs: null,
      linkSource,
    };
  }
  if (reference.trigger === 'pr_checks') {
    return {
      kind: 'pull-request',
      creates: false,
      lifecycle: reference.requestState ?? null,
      verifiedMerge: false,
      members: {},
      membersObservedAtMs: null,
      head: null,
      checksHeadSha: reference.checks.headSha,
      legacyChecksCompletedAtMs:
        reference.checks.observed === true ? null : reference.checks.completedAtMs,
      linkSource: null,
    };
  }
  if (reference.trigger === 'pr_head') {
    return {
      kind: 'pull-request',
      creates: false,
      lifecycle: null,
      verifiedMerge: false,
      members: {},
      membersObservedAtMs: null,
      head: reference.head,
      checksHeadSha: null,
      legacyChecksCompletedAtMs: null,
      linkSource: null,
    };
  }

  const snapshot = reference.request;
  const observedAtMs = snapshot?.state.observedAtMs ?? reference.head?.observedAtMs ?? null;
  const lifecycle =
    reference.trigger === 'pr_updated'
      ? (snapshot?.state ?? null)
      : { state: triggerStates[reference.trigger], observedAtMs };
  return {
    kind: 'pull-request',
    creates:
      reference.trigger === 'pr_open' ||
      (reference.trigger === 'pr_merged' &&
        (reference.referencedTaskKeys === undefined ||
          reference.referencedTaskKeys.includes(taskKey))),
    lifecycle,
    verifiedMerge: reference.trigger === 'pr_merged',
    members: snapshot?.members ?? {},
    membersObservedAtMs: snapshot?.state.observedAtMs ?? null,
    head: reference.head ?? null,
    checksHeadSha: null,
    legacyChecksCompletedAtMs: null,
    linkSource,
  };
}
