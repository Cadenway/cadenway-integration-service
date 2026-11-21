import type { GitDeliveryMapping } from '../../../../models/deliveries/git-delivery-mapping.model.js';
import type { GitRepositoryIdentity } from '../../../../models/deliveries/git-repository-identity.model.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';

/** Locked receiver transaction for mapping resolution and atomic delivery admission. */
export interface GitDeliveryTransaction {
  // #region Properties
  /** Resolves a known delivery ID under the locked receiver before considering any new work. */
  readonly checkDeliveryId: (
    deliveryId: string,
    digest: string,
  ) => Promise<'new' | 'duplicate' | 'conflict'>;

  /** Finds a current mapping under the locked receiver and its trusted organization. */
  readonly findMapping: (identity: GitRepositoryIdentity) => Promise<GitDeliveryMapping | null>;

  /** Selects existing linked tasks for the verified request and tested head, or null on overflow. */
  readonly findRequestTaskKeys: (
    binding: GitRepositoryIdentity,
    requestNumber: number,
    headSha?: string,
  ) => Promise<readonly string[] | null>;

  /** Finds earlier admitted work that can establish an authorized request link. */
  readonly findPendingRequestWork: (
    mapping: GitDeliveryMapping,
    requestNumber: number,
    triggers: readonly ('pr_open' | 'pr_head' | 'pr_merged')[],
  ) => Promise<readonly { readonly id: string; readonly taskKeys: readonly string[] }[] | null>;

  /** Admits a new ID checked in this transaction, reusing the existing receipt for a duplicate body. */
  readonly admit: (input: {
    readonly deliveryId: string;
    readonly digest: string;
    readonly work: {
      readonly mapping: GitDeliveryMapping;
      readonly fact: Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;
      readonly prerequisiteIds?: readonly string[];
    } | null;
  }) => Promise<'accepted' | 'duplicate'>;
  // #endregion
}
