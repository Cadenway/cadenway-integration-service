/** The merge intent of one link, identified by the tenant recorded with its job. */
export interface SubmitGitMergeIntentInput {
  // #region Properties
  /** Organization of the link and the link that owns the intent. */
  readonly organizationId: string;
  readonly linkId: string;
  // #endregion
}
