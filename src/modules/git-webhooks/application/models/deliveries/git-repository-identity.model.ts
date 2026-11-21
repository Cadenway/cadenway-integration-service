/** Provider repository identifiers extracted only from an authenticated body. */
export type GitRepositoryIdentity =
  | { readonly provider: 'github'; readonly repositoryId: number; readonly installationId: number }
  | { readonly provider: 'gitlab'; readonly repositoryId: number };
