/** Current lifecycle of a request as a verified delivery reports it, with its provider time. */
export interface VerifiedGitRequestState {
  // #region Properties
  /** Reported state and provider time in Unix milliseconds, or null when not carried. */
  readonly state: 'open' | 'closed' | 'merged';
  readonly observedAtMs: number | null;
  // #endregion
}
