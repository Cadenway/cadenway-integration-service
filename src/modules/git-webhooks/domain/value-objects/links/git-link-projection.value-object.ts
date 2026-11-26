import type { GitChecksAggregate } from '../checks/git-checks-aggregate.value-object.js';
import type { GitLinkMemberName } from './git-link-member-name.value-object.js';
import type { GitLinkMembers } from './git-link-members.value-object.js';
import type { GitLinkSource } from './git-link-source.value-object.js';

/**
 * Committed projection of one link with the watermarks that order later deliveries
 * (Ordering, Checks and Reconciliation in the Integration AsyncAPI).
 */
export interface GitLinkProjection {
  // #region Properties
  /**
   * Lifecycle, its strictly positive version and the provider time last applied to it. Each
   * watermark keeps the admission order of its delivery, which orders equal provider times.
   */
  readonly status: 'created' | 'open' | 'closed' | 'merged';
  readonly version: number;
  readonly lifecycleObservedAtMs: number | null;
  readonly lifecycleAdmissionSequence: number;

  /** Provider members and the provider time last applied to each of them. */
  readonly members: GitLinkMembers;
  readonly memberObservedAtMs: Readonly<Partial<Record<GitLinkMemberName, number>>>;
  readonly memberAdmissionSequence: Readonly<Partial<Record<GitLinkMemberName, number>>>;

  /** Where the task key was found when the link was created. */
  readonly linkSource: GitLinkSource | null;

  /** Current request head and the provider times it was first and last observed at. */
  readonly head: {
    readonly sha: string;
    readonly firstObservedAtMs: number;
    readonly lastObservedAtMs: number;
    readonly admissionSequence: number;
  } | null;

  /** Aggregate of the stored observations for the current head and its latest completion. */
  readonly checks: GitChecksAggregate | null;
  readonly checksCompletedAtMs: number | null;

  /** Internal mark left by an ambiguous equal-time lifecycle tie. */
  readonly reconciliationPending: boolean;
  // #endregion
}
