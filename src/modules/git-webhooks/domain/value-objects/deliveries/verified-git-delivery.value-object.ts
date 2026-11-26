import type { GitLinkMembers } from '../links/git-link-members.value-object.js';
import type { GitLinkSource } from '../links/git-link-source.value-object.js';
import type { VerifiedGitChecksCorrelation } from './verified-git-checks-correlation.value-object.js';
import type { VerifiedGitRequestSnapshot } from './verified-git-request-snapshot.value-object.js';
import type { VerifiedGitRequestState } from './verified-git-request-state.value-object.js';

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
 * `linkSources` names where each task key was first found, for a link created by the delivery.
 * `pr_head` is the head-only observation admitted by earlier versions and still settled.
 */
export type VerifiedGitDelivery =
  | { readonly kind: 'ignored' | 'repository_mismatch' }
  | ({
      readonly kind: 'actionable';
      readonly taskKeys: readonly string[];
      readonly closingTaskKeys: readonly string[];
      readonly linkSources?: Readonly<Record<string, GitLinkSource>>;
    } & (
      | {
          readonly trigger: 'branch';
          readonly branch: string;
          readonly members?: GitLinkMembers;
        }
      | {
          readonly trigger: 'pr_open' | 'pr_closed' | 'pr_reopened' | 'pr_updated';
          readonly requestNumber: number;
          readonly head?: GitRequestHead;
          readonly request?: VerifiedGitRequestSnapshot;
        }
      | {
          readonly trigger: 'pr_merged';
          readonly requestNumber: number;
          readonly head?: GitRequestHead;
          readonly request?: VerifiedGitRequestSnapshot;
          /** Signed references that can establish a link when no link was recorded previously. */
          readonly referencedTaskKeys?: readonly string[];
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
          /** Request state a GitLab merge request pipeline reports, used to realign the link. */
          readonly requestState?: VerifiedGitRequestState;
        }
    ));
