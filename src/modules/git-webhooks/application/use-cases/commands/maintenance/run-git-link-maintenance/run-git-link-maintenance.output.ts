import type { GitLinkFollowUp } from '../../../../models/maintenance/git-link-follow-up.model.js';

/** What one maintenance pass removed and what it reports for operator follow-up. */
export interface RunGitLinkMaintenanceOutput {
  // #region Properties
  /** Check observations pruned by this pass. */
  readonly prunedObservations: number;

  /** Links whose lifecycle tie awaits a qualifying delivery (no provider client before gap B5). */
  readonly reconciliationPending: readonly GitLinkFollowUp[];

  /** Merge intents left pending past Task's receipt window, reported once. */
  readonly unconfirmedMergeIntents: readonly GitLinkFollowUp[];
  // #endregion
}
