import type { GitMergeIntentCommand } from '../../../../models/merges/git-merge-intent-command.model.js';
import type { GitMergeIntentOutcome } from '../../../../models/merges/git-merge-intent-outcome.model.js';

/**
 * Short tenant transactions around one merge intent submission. Each locks the intent row, so
 * concurrent runs for one link serialize; the HTTP call to Task stays outside them.
 */
export interface GitMergeIntentUnitOfWork {
  // #region Properties
  /**
   * Claims the next attempt of a pending intent inside Task's receipt window. A handled or missing
   * intent is `settled`, one past the window is `expired`, and one whose receiver or mapping is no
   * longer enabled is `unavailable` and is retried like a failed submission.
   */
  readonly prepare: (input: {
    readonly organizationId: string;
    readonly linkId: string;
  }) => Promise<
    | { readonly status: 'ready'; readonly command: GitMergeIntentCommand }
    | { readonly status: 'unavailable'; readonly attempt: number }
    | { readonly status: 'settled' | 'expired' }
  >;

  /**
   * Records Task's answer for the claimed attempt. A confirmation or refusal marks the intent
   * `handled`; a failure schedules the next attempt with backoff, or leaves the intent `pending`
   * once the next attempt would fall outside the window. A later attempt supersedes this one.
   */
  readonly settle: (input: {
    readonly organizationId: string;
    readonly linkId: string;
    readonly attempt: number;
    readonly outcome: GitMergeIntentOutcome;
  }) => Promise<'handled' | 'retrying' | 'expired' | 'superseded'>;
  // #endregion
}
