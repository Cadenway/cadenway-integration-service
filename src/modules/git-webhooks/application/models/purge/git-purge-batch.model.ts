/** Identifies one bounded pass of a terminal Task purge. */
export interface GitPurgeBatch {
  // #region Properties
  /** The published Task event ID. */
  readonly eventId: string;

  /** The canonical key of the task erased by this event. */
  readonly taskKey: string;

  /** Starts at zero for the broker delivery and advances for each queued continuation. */
  readonly batch: number;
  // #endregion
}
