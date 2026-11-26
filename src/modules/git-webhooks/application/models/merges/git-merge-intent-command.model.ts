import type { GitDeliveryMapping } from '../deliveries/git-delivery-mapping.model.js';

/** One submission of a pending merge intent, sent to Task under its stable command identity. */
export interface GitMergeIntentCommand {
  // #region Properties
  /** Tenant, link and the attempt number this submission claimed. */
  readonly organizationId: string;
  readonly linkId: string;
  readonly attempt: number;

  /** `Idempotency-Key` derived from the creating delivery and task, reused on every attempt. */
  readonly commandKey: string;
  readonly taskKey: string;

  /** Mapping recorded with the intent and the target status of the merge. */
  readonly mapping: GitDeliveryMapping;
  readonly status: 'done';
  // #endregion
}
