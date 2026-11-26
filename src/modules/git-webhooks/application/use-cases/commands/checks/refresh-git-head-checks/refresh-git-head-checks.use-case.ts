import type { GitHeadChecksUnitOfWork } from '../../../../ports/outbound/transactions/checks/git-head-checks-unit-of-work.port.js';
import type { RefreshGitHeadChecksInput } from './refresh-git-head-checks.input.js';
import type { RefreshGitHeadChecksOutput } from './refresh-git-head-checks.output.js';

/** Links per page, the same bound as the task targets of one admitted delivery. */
const pageSize = 20;

/**
 * Refreshes the checks of every link whose current head is an observed head, in bounded pages
 * that resume after the last link of the previous one ("Checks", Integration AsyncAPI). Each
 * link still goes through Task's placement authorization, and its head is checked again when
 * its dispatch settles. Idempotent per page.
 */
export class RefreshGitHeadChecks {
  // #region Constructor
  /** Uses the page's tenant transaction. */
  public constructor(private readonly work: GitHeadChecksUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Records one page and queues the next one when more links follow. */
  public async execute(input: RefreshGitHeadChecksInput): Promise<RefreshGitHeadChecksOutput> {
    if (!Number.isSafeInteger(input.page) || input.page < 0) {
      throw new Error('The head refresh page is out of range.');
    }
    return this.work.refresh(input, pageSize);
  }
  // #endregion
}
