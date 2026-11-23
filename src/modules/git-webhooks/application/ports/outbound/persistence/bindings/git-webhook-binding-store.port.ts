import type { ManageGitWebhookBindingInput } from '../../../../use-cases/commands/bindings/manage-git-webhook-binding/manage-git-webhook-binding.input.js';

type Registration = Extract<ManageGitWebhookBindingInput, { readonly action: 'register' }>;

/** Locked receiver registration and its mappings in one tenant transaction. */
export interface GitWebhookBindingStore {
  // #region Methods
  /** Inserts a new receiver at its initial revision if its binding ID is unclaimed. */
  insertReceiver(input: Registration): Promise<void>;

  /** Locks the receiver, returning no row for another tenant, ID or provider. */
  lockReceiver(
    input: ManageGitWebhookBindingInput,
  ): Promise<{ readonly revision: number; readonly enabled: boolean } | null>;

  /** Registers the same immutable mapping idempotently, rejecting conflicting metadata. */
  registerMapping(input: Registration): Promise<boolean>;

  /** Updates the revision or enabled state of the receiver held by this transaction. */
  updateReceiver(
    input: ManageGitWebhookBindingInput,
    state: { readonly revision: number; readonly enabled: boolean },
  ): Promise<void>;
  // #endregion
}
