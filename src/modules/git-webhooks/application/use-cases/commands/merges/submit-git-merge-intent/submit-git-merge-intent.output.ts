/** Where the merge intent stands after one submission. */
export interface SubmitGitMergeIntentOutput {
  // #region Properties
  /**
   * `handled` after Task's confirmation or refusal, `retrying` with a scheduled attempt,
   * `expired` when it stays pending past Task's receipt window, `settled` when nothing was due.
   */
  readonly status: 'handled' | 'retrying' | 'expired' | 'settled';
  // #endregion
}
