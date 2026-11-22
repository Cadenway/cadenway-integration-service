import type { GitDispatchClaim } from '../../../../models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskActionResult } from '../../../../models/dispatch/git-task-action-result.model.js';

/** Owns tenant-scoped decisions and durable state for one admitted delivery and task. */
export interface GitDispatchUnitOfWork {
  // #region Properties
  /** Locks and verifies receiver, mapping and target before reserving or restoring the claim. */
  readonly prepare: (input: {
    readonly organizationId: string;
    readonly deliveryId: string;
    readonly taskKey: string;
  }) => Promise<
    | { readonly status: 'ready'; readonly claim: GitDispatchClaim }
    | { readonly status: 'closed' | 'completed' | 'deferred' }
  >;

  /**
   * Rechecks the receiver revision and mapping, then finalizes the link under lock.
   * An unavailable Task target or a mapping disabled while Task was running closes the claim
   * without creating a link.
   * Task may already have committed the command it authorized before that disablement.
   */
  readonly finish: (input: {
    readonly organizationId: string;
    readonly deliveryId: string;
    readonly claim: GitDispatchClaim;
    readonly result: GitTaskActionResult;
  }) => Promise<'completed' | 'closed'>;
  // #endregion
}
