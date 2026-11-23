import type { GitWebhookBindingStore } from '../../persistence/bindings/git-webhook-binding-store.port.js';

/** Runs operator changes in the selected organization using its own row-level policy. */
export interface GitWebhookBindingUnitOfWork {
  // #region Methods
  /** Commits the command atomically and rolls it back on any conflict. */
  run<T>(
    organizationId: string,
    operation: (store: GitWebhookBindingStore) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
