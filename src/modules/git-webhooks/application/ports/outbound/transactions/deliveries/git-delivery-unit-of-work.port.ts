import type { GitWebhookReceiver } from '../../../../models/deliveries/git-webhook-receiver.model.js';
import type { GitDeliveryTransaction } from './git-delivery-transaction.port.js';

/** Looks up an opaque receiver and owns its tenant-scoped admission transaction. */
export interface GitDeliveryUnitOfWork {
  // #region Properties
  /** Selects signing credentials for the receiver from trusted settings. */
  readonly findReceiver: (
    bindingId: string,
    provider: 'github' | 'gitlab',
  ) => Promise<GitWebhookReceiver | null>;

  /** Locks and rechecks active receiver revision before using its tenant transaction. */
  readonly run: <T>(
    receiver: GitWebhookReceiver,
    work: (transaction: GitDeliveryTransaction) => Promise<T>,
  ) => Promise<{ readonly active: false } | { readonly active: true; readonly result: T }>;
  // #endregion
}
