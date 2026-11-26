import type { VerifiedGitRequestState } from '../deliveries/verified-git-request-state.value-object.js';
import type { GitLinkMembers } from './git-link-members.value-object.js';
import type { GitLinkSource } from './git-link-source.value-object.js';

/** What one verified delivery contributes to one authorized link of one task. */
export interface GitLinkDelivery {
  // #region Properties
  /** Whether the delivery may create the link: a branch, an opening or a referencing merge. */
  readonly kind: 'branch' | 'pull-request';
  readonly creates: boolean;

  /** Admission order of the delivery, which breaks ties between equal provider times. */
  readonly admissionSequence: number;

  /** Lifecycle the delivery carries for a request, with its provider time. */
  readonly lifecycle: VerifiedGitRequestState | null;

  /** Whether the delivery is the verified merge action itself, final whatever its time. */
  readonly verifiedMerge: boolean;

  /** Members the delivery carries and their provider time, null when it has none. */
  readonly members: GitLinkMembers;
  readonly membersObservedAtMs: number | null;

  /** Request head the delivery observed, with its provider time. */
  readonly head: { readonly sha: string; readonly observedAtMs: number } | null;

  /** Head SHA of a check observation delivery. */
  readonly checksHeadSha: string | null;

  /** Completion time of a check receipt admitted by the previous release, without observation. */
  readonly legacyChecksCompletedAtMs: number | null;

  /** Where the task key was found, used when the delivery creates the link. */
  readonly linkSource: GitLinkSource | null;
  // #endregion
}
