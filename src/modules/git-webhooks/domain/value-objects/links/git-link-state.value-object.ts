import type { GitLinkIdentity } from './git-link-identity.value-object.js';

/** Last committed material state of a link, with its strictly positive version. */
export interface GitLinkState {
  // #region Properties
  /** Persists the stable identity together with the current state and version. */
  readonly identity: GitLinkIdentity;
  readonly status: 'created' | 'open' | 'closed' | 'merged';
  readonly version: number;
  // #endregion
}
