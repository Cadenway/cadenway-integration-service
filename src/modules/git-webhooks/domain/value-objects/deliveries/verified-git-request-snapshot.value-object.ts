import type { GitLinkMembers } from '../links/git-link-members.value-object.js';
import type { VerifiedGitRequestState } from './verified-git-request-state.value-object.js';

/** What a verified pull or merge request delivery reports about the request's current state. */
export interface VerifiedGitRequestSnapshot {
  // #region Properties
  /** Reported lifecycle and the provider time shared by every member of the delivery. */
  readonly state: VerifiedGitRequestState;

  /** Provider members carried by the delivery; a missing one is left as recorded. */
  readonly members: GitLinkMembers;
  // #endregion
}
