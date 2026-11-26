import type { GitRepositoryIdentity } from '../deliveries/git-repository-identity.model.js';

/**
 * One page of the refresh of every link whose current head is a verified check observation's
 * head, in the receiver's repository ("Checks", Integration AsyncAPI). Pages follow the
 * `(taskKey, linkId)` order and resume after `after`.
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

  /** Request whose links the delivery's own work already refreshes, if any. */
  readonly excludeRequestNumber: number | null;

  /** Position of the last link of the previous page. */
  readonly after: { readonly taskKey: string; readonly linkId: string } | null;
  // #endregion
}
