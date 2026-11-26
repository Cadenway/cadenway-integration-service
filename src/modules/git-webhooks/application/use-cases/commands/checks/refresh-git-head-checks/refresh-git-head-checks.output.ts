/** What one page of a head refresh recorded. */
export interface RefreshGitHeadChecksOutput {
  // #region Properties
  /** `stopped` once the receiver or mapping is no longer enabled. */
  readonly status: 'refreshed' | 'stopped';

  /** Links the page queued for refresh, and whether a further page was queued. */
  readonly links: number;
  readonly more: boolean;
  // #endregion
}
