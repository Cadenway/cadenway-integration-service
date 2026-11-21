/** Identity of one target already selected from an authenticated, admitted delivery. */
export interface DispatchGitDeliveryInput {
  // #region Properties
  /** Organization recorded against the receiver, never supplied by a provider body. */
  readonly organizationId: string;
  readonly deliveryId: string;
  readonly taskKey: string;
  // #endregion
}
