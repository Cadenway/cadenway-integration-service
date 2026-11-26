/** A link an operator must follow up, identified without provider data. */
export interface GitLinkFollowUp {
  // #region Properties
  /** Tenant and link. */
  readonly organizationId: string;
  readonly gitLinkId: string;
  // #endregion
}
