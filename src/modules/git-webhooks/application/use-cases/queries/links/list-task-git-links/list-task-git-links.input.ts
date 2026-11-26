/** One page request for a task's links, bounded by the caller's verified organization. */
export interface ListTaskGitLinksInput {
  // #region Properties
  /** Organization of the internal token and the task key of the route. */
  readonly organizationId: string;
  readonly taskKey: string;

  /** Position of the last link of the previous page, and the page size from 1 to 100. */
  readonly after: { readonly createdAt: string; readonly id: string } | null;
  readonly limit: number;
  // #endregion
}
