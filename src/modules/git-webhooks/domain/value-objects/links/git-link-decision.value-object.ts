import type { GitLinkChanged } from '../../events/links/git-link-changed.event.js';
import type { GitLinkProjection } from './git-link-projection.value-object.js';

/** Result of applying one delivery to a link: the projection to store and its facts in order. */
export interface GitLinkDecision {
  // #region Properties
  /** Projection to persist, including watermarks that changed without a fact. */
  readonly projection: GitLinkProjection;

  /** Facts to append, each with the next version of the link. */
  readonly events: readonly GitLinkChanged[];

  /** Whether the delivery set, cleared or left the reconciliation mark. */
  readonly reconciliation: 'marked' | 'cleared' | 'unchanged';
  // #endregion
}
