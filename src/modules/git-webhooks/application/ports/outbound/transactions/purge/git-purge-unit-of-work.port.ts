import type { GitPurgeTransaction } from './git-purge-transaction.port.js';

/** Provides a tenant transaction for one link purge batch. */
export interface GitPurgeUnitOfWork {
  // #region Properties
  /** Joins the broker receipt transaction when one is active. */
  readonly run: (
    organizationId: string,
    work: (transaction: GitPurgeTransaction) => Promise<void>,
  ) => Promise<void>;
  // #endregion
}
