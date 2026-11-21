/** Completion state of the target's durable dispatch decision. */
export interface DispatchGitDeliveryOutput {
  // #region Properties
  /** Terminal state of this target's dispatch. */
  readonly status: 'completed' | 'closed';
  // #endregion
}
