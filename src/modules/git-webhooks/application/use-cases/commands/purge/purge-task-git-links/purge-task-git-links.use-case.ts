import type { GitPurgeUnitOfWork } from '../../../../ports/outbound/transactions/purge/git-purge-unit-of-work.port.js';
import type { PurgeTaskGitLinksInput } from './purge-task-git-links.input.js';

/** Removes one batch of links and durably schedules the next pass if needed. */
export class PurgeTaskGitLinks {
  // #region Constructor
  /** Binds the service-owned purge transaction. */
  public constructor(private readonly work: GitPurgeUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Commits terminal deletion and its next occurrence together. */
  public async execute(input: PurgeTaskGitLinksInput): Promise<void> {
    const { organizationId, eventId, taskKey, batch, signal } = input;
    signal.throwIfAborted();
    await this.work.run(organizationId, async (transaction) => {
      signal.throwIfAborted();
      const { hasMore } = await transaction.purge(taskKey);
      signal.throwIfAborted();
      if (!hasMore) return;

      const next = batch + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Git purge continuation limit reached.');
      await transaction.enqueue({ eventId, taskKey, batch: next });
      signal.throwIfAborted();
    });
  }
  // #endregion
}
