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
      | { readonly trigger: 'pr_open' | 'pr_merged' | 'pr_closed'; readonly requestNumber: number }
    ));
