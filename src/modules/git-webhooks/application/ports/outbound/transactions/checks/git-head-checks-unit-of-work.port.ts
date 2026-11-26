import type { GitHeadChecksPage } from '../../../../models/checks/git-head-checks-page.model.js';

/** Admits one page of a head refresh in its tenant, under the receiver lock. */
export interface GitHeadChecksUnitOfWork {
  // #region Properties
  /**
   * Selects up to `limit` links of the page, records them as one receipt whose targets each get a
   * dispatch job, and queues the next page when more links follow, all in one transaction. A page
   * already recorded is not recorded twice. Returns `stopped` when the receiver or the mapping is
   * no longer enabled.
   */
  readonly refresh: (
    page: GitHeadChecksPage,
    limit: number,
  ) => Promise<{
    readonly status: 'refreshed' | 'stopped';
    readonly links: number;
    readonly more: boolean;
  }>;
  // #endregion
}
