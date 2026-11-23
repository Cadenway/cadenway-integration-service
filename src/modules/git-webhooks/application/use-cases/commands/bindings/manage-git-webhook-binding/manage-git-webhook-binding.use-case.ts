import type { GitWebhookBindingUnitOfWork } from '../../../../ports/outbound/transactions/bindings/git-webhook-binding-unit-of-work.port.js';
import type { ManageGitWebhookBindingInput } from './manage-git-webhook-binding.input.js';

class BindingConflict extends Error {}

/** Atomically registers a binding or fences its previous signing revision. */
export class ManageGitWebhookBinding {
  // #region Constructor
  /** Uses the same receiver row lock as webhook admission. */
  public constructor(private readonly work: GitWebhookBindingUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Returns false for stale, revoked or conflicting registrations without disclosing ownership. */
  public async execute(input: ManageGitWebhookBindingInput): Promise<boolean> {
    try {
      await this.work.run(input.organizationId, async (store) => {
        if (input.action === 'register' && input.revision === 1) {
          await store.insertReceiver(input);
        }
        const current = await store.lockReceiver(input);
        if (current === null) throw new BindingConflict();

        if (input.action === 'rotate') {
          if (!current.enabled || input.revision === Number.MAX_SAFE_INTEGER) {
            throw new BindingConflict();
          }
          const nextRevision = input.revision + 1;
          if (current.revision === nextRevision) return;
          if (current.revision !== input.revision) throw new BindingConflict();
          await store.updateReceiver(input, { revision: nextRevision, enabled: true });
          return;
        }

        if (current.revision !== input.revision) throw new BindingConflict();
        if (input.action === 'revoke') {
          if (current.enabled) {
            await store.updateReceiver(input, { revision: current.revision, enabled: false });
          }
          return;
        }
        if (!current.enabled || !(await store.registerMapping(input))) {
          throw new BindingConflict();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof BindingConflict) return false;
      throw error;
    }
  }
  // #endregion
}
