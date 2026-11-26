import type { GitLinkFollowUp } from '../../../../models/maintenance/git-link-follow-up.model.js';

/** Emits what an operator must follow up; a report is only marked once it has been emitted. */
export interface GitLinkFollowUpReporter {
  // #region Properties
  /** Reports links marked `reconciliation pending` or merge intents left unconfirmed. */
  readonly report: (
    kind: 'reconciliation-pending' | 'unconfirmed-merge-intent',
    followUps: readonly GitLinkFollowUp[],
  ) => Promise<void>;
  // #endregion
}
