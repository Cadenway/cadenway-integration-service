/** Identifies a completed provider check against an already authorized pull request link. */
export interface VerifiedGitChecksCorrelation {
  // #region Properties
  /** Repository-local PR or MR number and the exact tested revision. */
  readonly requestNumber: number;
  readonly headSha: string;

  /** Provider suite or pipeline ID, which may also identify a later retry. */
  readonly attemptId: number;

  /** Signed suite update or pipeline finish time in Unix milliseconds. */
  readonly completedAtMs: number;
  // #endregion
}
