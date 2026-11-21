import type { VerifiedGitChecksCorrelation } from './verified-git-checks-correlation.value-object.js';

interface GitRequestHead {
  // #region Properties
  /** Exact revision and the provider's observation time in Unix milliseconds. */
  readonly sha: string;
  readonly observedAtMs: number;
  // #endregion
}

/**
 * Candidate automation input derived from authenticated provider data.
 * These references still require current authorization in the space mapped to the receiver.
 */
export type VerifiedGitDelivery =
  | { readonly kind: 'ignored' | 'repository_mismatch' }
  | ({
      readonly kind: 'actionable';
      readonly taskKeys: readonly string[];
      readonly closingTaskKeys: readonly string[];
    } & (
      | { readonly trigger: 'branch'; readonly branch: string }
      | {
          readonly trigger: 'pr_open' | 'pr_merged' | 'pr_closed';
          readonly requestNumber: number;
          readonly head?: GitRequestHead;
        }
      | {
          readonly trigger: 'pr_head';
          readonly requestNumber: number;
          readonly head: GitRequestHead;
        }
      | {
          readonly trigger: 'pr_checks';
          readonly requestNumber: number;
          readonly checks: VerifiedGitChecksCorrelation;
          readonly head?: never;
        }
    ));
