interface ReceiverSelector {
  // #region Properties
  /** Organization in which to perform the command. */
  readonly organizationId: string;

  /** Opaque receiver registration UUID. */
  readonly bindingId: string;

  /** Provider associated with that receiver. */
  readonly provider: 'github' | 'gitlab';
  // #endregion
}

/** Non-secret operator metadata for an exact receiver and revision. */
export type ManageGitWebhookBindingInput = ReceiverSelector &
  (
    | {
        readonly action: 'register';
        readonly revision: number;
        readonly repositoryId: number;
        readonly installationId: number | null;
        readonly integrationId: string;
        readonly spaceId: string;
        readonly mappingAuthorUserId: string;
      }
    | { readonly action: 'rotate'; readonly revision: number }
    | { readonly action: 'revoke'; readonly revision: number }
  );
