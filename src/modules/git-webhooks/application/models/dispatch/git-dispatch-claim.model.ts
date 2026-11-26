import type { GitDeliveryMapping } from '../deliveries/git-delivery-mapping.model.js';
import type { VerifiedGitDelivery } from '../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';

/** Immutable delivery and target decision reserved under the receiver's tenant lock. */
export interface GitDispatchClaim {
  // #region Properties
  /** Tenant of the receiver and of the outbound Task command. */
  readonly organizationId: string;

  /** Admitted delivery receipt the claim settles. */
  readonly deliveryId: string;

  /** Stable Task command key, reused for every retry of this delivery and task. */
  readonly commandKey: string;
  readonly taskKey: string;
  readonly receiverRevision: number;
  readonly mapping: GitDeliveryMapping;
  readonly fact: Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;
  // #endregion
}
