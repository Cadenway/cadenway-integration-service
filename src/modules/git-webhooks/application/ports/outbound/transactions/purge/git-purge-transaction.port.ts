import type { GitPurgeBatch } from '../../../../models/purge/git-purge-batch.model.js';

/** Groups the terminal marker, deletion batch and continuation in a single transaction. */
export interface GitPurgeTransaction {
  // #region Properties
  /** Marks the task as permanently purged and returns whether another pass may be needed. */
  readonly purge: (taskKey: string) => Promise<{ readonly hasMore: boolean }>;

  /** Records the next pass under the same transaction. */
  readonly enqueue: (batch: GitPurgeBatch) => Promise<void>;
  // #endregion
}
