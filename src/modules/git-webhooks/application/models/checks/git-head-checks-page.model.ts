import type { VerifiedGitRequestState } from '../../../domain/value-objects/deliveries/verified-git-request-state.value-object.js';
import type { GitRepositoryIdentity } from '../deliveries/git-repository-identity.model.js';

/**
 * One page of the refresh a verified check observation starts in the receiver's repository
 * ("Checks" and "Reconciliation", Integration AsyncAPI): every link whose current head is the
 * observed head, or every link of the merge request a GitLab pipeline reports the state of.
 * Pages follow the `(taskKey, linkId)` order and resume after `after`.
 */
export interface GitHeadChecksPage {
  // #region Properties
  /** Tenant and receiver of the admitted check delivery, and the verified repository. */
  readonly organizationId: string;
  readonly receiverId: string;
  readonly binding: GitRepositoryIdentity;

  /** Observed head, suite or pipeline and provider time of the observation. */
  readonly headSha: string;
  readonly attemptId: number;
  readonly observedAtMs: number;

  /** Digest of the check delivery, which names its refresh, and the page number. */
  readonly source: string;
  readonly page: number;

  /** The links of the observed head, or those of the reported request whatever their head. */
  readonly target:
    | { readonly kind: 'head' }
    | {
        readonly kind: 'request';
        readonly requestNumber: number;
        readonly requestState: VerifiedGitRequestState;
      };

  /** Position of the last link of the previous page. */
  readonly after: { readonly taskKey: string; readonly linkId: string } | null;
  // #endregion
}
