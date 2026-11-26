import type { GitLinkFollowUp } from '../../../../models/maintenance/git-link-follow-up.model.js';

/** What one maintenance pass removed, resumed and reports for operator follow-up. */
export interface RunGitLinkMaintenanceOutput {
  // #region Properties
  /** Check observations pruned by this pass. */
  readonly prunedObservations: number;

  /** Pending merge intents whose next attempt the pass made sure is queued. */
  readonly resumedMergeIntents: number;

  /** Links newly marked for reconciliation (no provider client before gap B5), reported once. */
  readonly reconciliationPending: readonly GitLinkFollowUp[];

  /** Merge intents left pending past Task's receipt window, reported once. */
  readonly unconfirmedMergeIntents: readonly GitLinkFollowUp[];
  // #endregion
}
