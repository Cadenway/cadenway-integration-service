import type { GitReceiverBinding } from '../../../domain/value-objects/deliveries/git-receiver-binding.value-object.js';

/** Current trusted repository mapping supplying the Task authorization context. */
export interface GitDeliveryMapping {
  // #region Properties
  /** Provider identity and the authorized Task placement. */
  readonly binding: GitReceiverBinding;
  readonly integrationId: string;
  readonly spaceId: string;
  readonly mappingAuthorUserId: string;
  // #endregion
}
