import type { GitLinkFollowUp } from '../../../../models/maintenance/git-link-follow-up.model.js';

/** System transactions across organizations for the scheduled Git link maintenance. */
export interface GitLinkMaintenanceUnitOfWork {
  // #region Properties
  /** Deletes up to `limit` expired check observations and returns how many it deleted. */
  readonly pruneCheckObservations: (limit: number) => Promise<number>;

  /** Lists up to `limit` links still marked `reconciliation pending`, oldest mark first. */
  readonly findReconciliationPending: (limit: number) => Promise<readonly GitLinkFollowUp[]>;

  /**
   * Marks as reported, and returns, up to `limit` merge intents still pending once Task's
   * receipt window has passed. Each one is reported once.
   */
  readonly reportUnconfirmedMergeIntents: (limit: number) => Promise<readonly GitLinkFollowUp[]>;
  // #endregion
}
