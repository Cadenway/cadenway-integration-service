import type { TaskGitLink } from '../../../../projections/links/task-git-link.projection.js';

/** Reads a task's links in the caller's organization, newest first by `(createdAt, id)`. */
export interface TaskGitLinkReader {
  // #region Properties
  /**
   * Returns at most `limit` links strictly after `after` in descending `(createdAt, id)` order.
   * A purged task has no links.
   */
  readonly listTaskLinks: (input: {
    readonly organizationId: string;
    readonly taskKey: string;
    readonly after: { readonly createdAt: string; readonly id: string } | null;
    readonly limit: number;
  }) => Promise<readonly TaskGitLink[]>;
  // #endregion
}
