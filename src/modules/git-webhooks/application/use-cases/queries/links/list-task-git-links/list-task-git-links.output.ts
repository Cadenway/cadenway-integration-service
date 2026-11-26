import type { TaskGitLink } from '../../../../projections/links/task-git-link.projection.js';

/** One page of a task's links and the position the next page starts after. */
export interface ListTaskGitLinksOutput {
  // #region Properties
  /** At most `limit` links, newest first. */
  readonly items: readonly TaskGitLink[];

  /** Position of the last item when another page exists, otherwise null. */
  readonly next: { readonly createdAt: string; readonly id: string } | null;
  // #endregion
}
