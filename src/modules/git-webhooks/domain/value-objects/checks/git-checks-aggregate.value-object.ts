/** Aggregate checks of a link's current head (GitChecks in the Integration contract). */
export interface GitChecksAggregate {
  // #region Properties
  /** Outcome over the eligible recorded set. */
  readonly state: 'passed' | 'failed' | 'running';

  /** Suites (GitHub) or pipeline jobs (GitLab), and those that failed, when known. */
  readonly total?: number;
  readonly failed?: number;
  // #endregion
}
