/** Identifies a provider check observation against an already authorized pull request link. */
export interface VerifiedGitChecksCorrelation {
  // #region Properties
  /** Repository-local PR or MR number and the exact tested revision. */
  readonly requestNumber: number;
  readonly headSha: string;

  /** Provider suite or pipeline ID, which may also identify a later retry. */
  readonly attemptId: number;

  /** Provider time of the observation in Unix milliseconds. */
  readonly completedAtMs: number;

  /**
   * Set when admission stored the observation. A receipt of the previous release lacks it and
   * only carries a completed suite or pipeline.
   */
  readonly observed?: true;
  // #endregion
}
