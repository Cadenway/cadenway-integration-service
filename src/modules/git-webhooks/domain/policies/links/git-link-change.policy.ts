import { InvalidGitLinkError } from '../../errors/links/invalid-git-link.error.js';
import type { GitLinkChanged } from '../../events/links/git-link-changed.event.js';
import type { VerifiedGitDelivery } from '../../value-objects/deliveries/verified-git-delivery.value-object.js';
import type { GitLinkIdentity } from '../../value-objects/links/git-link-identity.value-object.js';
import type { GitLinkState } from '../../value-objects/links/git-link-state.value-object.js';

type LinkScope = Pick<GitLinkIdentity, 'organizationId' | 'receiverId' | 'binding' | 'taskId'>;
type LinkReference = Extract<VerifiedGitDelivery, { kind: 'actionable' }>;

const outcomes = {
  branch: { status: 'created', type: 'branch-created' },
  pr_open: { status: 'open', type: 'pull-request-opened' },
  pr_merged: { status: 'merged', type: 'pull-request-merged' },
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
  if (!Number.isSafeInteger(requestNumber) || requestNumber < 1) throw new InvalidGitLinkError();
  return { organizationId, receiverId, binding, taskId, kind: 'pull-request', requestNumber };
}

/**
 * Applies the Integration AsyncAPI link ordering rule. Replays and older open deliveries
 * after merge produce no fact or version change. The caller commits state and fact together.
 */
export function decideGitLinkChange(
  identity: GitLinkIdentity,
  current: GitLinkState | null,
  reference: LinkReference,
): { readonly state: GitLinkState; readonly event: GitLinkChanged } | null {
  if (!isSameLink(identity, gitLinkIdentity(identity, reference))) throw new InvalidGitLinkError();
  const { status, type } = outcomes[reference.trigger];
  if (current !== null) {
    if (
      !isSameLink(identity, current.identity) ||
      (current.status === 'created') !== (identity.kind === 'branch') ||
      !Number.isSafeInteger(current.version) ||
      current.version < 1
    ) {
      throw new InvalidGitLinkError();
    }
    if (current.status === status || current.status === 'merged') return null;
  }

  const version = (current?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version)) throw new InvalidGitLinkError();
  return { state: { identity, status, version }, event: { type, version } };
}

function isSameLink(first: GitLinkIdentity, second: GitLinkIdentity): boolean {
  if (
    first.organizationId !== second.organizationId ||
    first.receiverId !== second.receiverId ||
    first.taskId !== second.taskId ||
    first.binding.repositoryId !== second.binding.repositoryId ||
    first.binding.provider !== second.binding.provider
  ) {
    return false;
  }
  if (
    first.binding.provider === 'github' &&
    second.binding.provider === 'github' &&
    first.binding.installationId !== second.binding.installationId
  ) {
    return false;
  }
  return first.kind === 'branch'
    ? second.kind === 'branch' && first.ref === second.ref
    : second.kind === 'pull-request' && first.requestNumber === second.requestNumber;
}
