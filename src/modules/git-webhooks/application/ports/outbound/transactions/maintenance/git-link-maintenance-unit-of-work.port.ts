import type { GitLinkFollowUp } from '../../../../models/maintenance/git-link-follow-up.model.js';

/** Bounded transactions across organizations for the scheduled Git link maintenance. */
export interface GitLinkMaintenanceUnitOfWork {
  // #region Properties
  /** Deletes up to `limit` expired check observations and returns how many it deleted. */
  readonly pruneCheckObservations: (limit: number) => Promise<number>;

  /**
   * Lists up to `limit` links marked `reconciliation pending` and not reported since they were
   * marked, oldest mark first. A `merged` link is final and is not listed.
   */
  readonly findReconciliationPending: (limit: number) => Promise<readonly GitLinkFollowUp[]>;

  /** Marks the listed links reported, unless they were marked again or cleared meanwhile. */
  readonly markReconciliationReported: (followUps: readonly GitLinkFollowUp[]) => Promise<void>;

  /** Lists up to `limit` merge intents still pending past Task's receipt window, unreported. */
  readonly findUnconfirmedMergeIntents: (limit: number) => Promise<readonly GitLinkFollowUp[]>;

  /** Marks the listed merge intents reported, unless they were handled meanwhile. */
  readonly markMergeIntentsReported: (followUps: readonly GitLinkFollowUp[]) => Promise<void>;

  /**
   * Enqueues the next attempt of up to `limit` pending merge intents still inside Task's receipt
   * window, in their own tenant. Returns how many intents it looked at.
   */
  readonly resumePendingMergeIntents: (limit: number) => Promise<number>;
  // #endregion
}
