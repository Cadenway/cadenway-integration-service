import type { GitDispatchClaim } from '../../../../models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskActionResult } from '../../../../models/dispatch/git-task-action-result.model.js';
import type { GitMergeIntentCommand } from '../../../../models/merges/git-merge-intent-command.model.js';
import type { GitMergeIntentOutcome } from '../../../../models/merges/git-merge-intent-outcome.model.js';

/** Applies the verified Git fact through Task's idempotent authorized command. */
export interface GitTaskAction {
  // #region Properties
  /** Reuses the claim's command key for an uncertain or repeated downstream call. */
  readonly apply: (
    claim: GitDispatchClaim,
    status: 'progress' | 'review' | 'done' | null,
  ) => Promise<GitTaskActionResult>;

  /**
   * Submits a merge intent under its command identity. Timeouts, transport errors and
   * retryable answers resolve to `failed`, never to a refusal.
   */
  readonly submitMergeIntent: (command: GitMergeIntentCommand) => Promise<GitMergeIntentOutcome>;
  // #endregion
}
