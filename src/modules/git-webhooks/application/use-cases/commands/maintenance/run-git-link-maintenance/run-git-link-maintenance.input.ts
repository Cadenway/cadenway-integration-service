/** One scheduled maintenance pass, which crosses organizations. */
export interface RunGitLinkMaintenanceInput {
  // #region Properties
  /** Aborted when the job attempt can no longer succeed. */
  readonly signal?: AbortSignal;
  // #endregion
}
