/** Completion state of the target's durable dispatch decision. */
export interface DispatchGitDeliveryOutput {
  // #region Properties
  /** Terminal decision or a durable continuation for the same target. */
  readonly status: 'completed' | 'closed' | 'deferred';
  // #endregion
}
