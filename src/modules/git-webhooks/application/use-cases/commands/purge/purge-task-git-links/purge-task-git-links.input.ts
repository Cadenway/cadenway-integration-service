import type { GitPurgeBatch } from '../../../../models/purge/git-purge-batch.model.js';

/** Carries one pass and the tenant established by the trusted delivery envelope. */
export interface PurgeTaskGitLinksInput extends GitPurgeBatch {
  // #region Properties
  /** Organization verified at the broker or job boundary. */
  readonly organizationId: string;

  /** Stops an attempt whose broker or worker deadline has elapsed. */
  readonly signal: AbortSignal;
  // #endregion
}
