import type { GitLinkFollowUp } from '../../../../models/maintenance/git-link-follow-up.model.js';

/** Bounded transactions across organizations for the scheduled Git link maintenance. */
export interface GitLinkMaintenanceUnitOfWork {
  // #region Properties
  /** Deletes up to `limit` expired check observations and returns how many it deleted. */
  readonly pruneCheckObservations: (limit: number) => Promise<number>;

  /**
   * Marks as reported, and returns, up to `limit` links marked `reconciliation pending` that
   * were not reported since they were marked, oldest mark first. A `merged` link is final and
   * is not reported.
   */
  readonly reportReconciliationPending: (limit: number) => Promise<readonly GitLinkFollowUp[]>;

  /**
   * Marks as reported, and returns, up to `limit` merge intents still pending once Task's
   * receipt window has passed. Each one is reported once.
   */
  readonly reportUnconfirmedMergeIntents: (limit: number) => Promise<readonly GitLinkFollowUp[]>;

  /**
   * Enqueues the next attempt of up to `limit` pending merge intents still inside Task's receipt
   * window, in their own tenant. An attempt already queued is not enqueued again. Returns how
   * many intents it looked at.
   */
  readonly resumePendingMergeIntents: (limit: number) => Promise<number>;
  // #endregion
}
