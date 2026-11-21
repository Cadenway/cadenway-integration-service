/**
 * A material link change to publish with Integration's assigned link ID and Task's placement.
 * Provider references and message contents stay out of the event.
 */
export interface GitLinkChanged {
  // #region Properties
  /** Name of the material change and the version assigned to it. */
  readonly type:
    'branch-created' | 'pull-request-opened' | 'pull-request-closed' | 'pull-request-merged';
  readonly version: number;
  // #endregion
}
