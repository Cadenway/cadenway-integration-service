/** Active receiver credentials read under the receiver's trusted organization. */
export interface GitWebhookReceiver {
  // #region Properties
  /** Opaque registration selected by the gateway request. */
  readonly bindingId: string;
  readonly organizationId: string;
  readonly provider: 'github' | 'gitlab';
  readonly revision: number;
  readonly signingSecret: string;
  // #endregion
}
