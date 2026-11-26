/**
 * Optional provider members of a link read from verified webhook payloads, as listed by
 * `GitLink` in the Integration contract and shown in the Development panel
 * (App.dc.html:4328–4360). Each member stays absent until a delivery records it.
 */
export interface GitLinkMembers {
  // #region Properties
  /** Request title and draft flag. Never present for a branch. */
  readonly title?: string;
  readonly draft?: boolean;

  /** Web address of the request or the branch. */
  readonly url?: string;

  /** Repository or project name and web address. */
  readonly repository?: { readonly fullName: string; readonly url: string };

  /** Source branch of a request. */
  readonly sourceBranch?: string;

  /** Provider account that opened the request or created the branch. */
  readonly author?: { readonly login: string; readonly name?: string };

  /** Whether reviewers are requested on the request. */
  readonly reviewRequested?: boolean;

  /** GitHub line counts of the request. */
  readonly additions?: number;
  readonly deletions?: number;
  // #endregion
}
