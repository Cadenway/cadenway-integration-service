import type { GitDeliveryMapping } from '../../../../models/deliveries/git-delivery-mapping.model.js';
import type { GitRepositoryIdentity } from '../../../../models/deliveries/git-repository-identity.model.js';
import type { GitCheckObservation } from '../../../../../domain/value-objects/checks/git-check-observation.value-object.js';
import type { VerifiedGitRequestState } from '../../../../../domain/value-objects/deliveries/verified-git-request-state.value-object.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';

/** Locked receiver transaction for mapping resolution and atomic delivery admission. */
export interface GitDeliveryTransaction {
  // #region Properties
  /** Checks the delivery ID and, for GitHub, the authenticated body under the receiver lock. */
  readonly checkDelivery: (
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

  /**
   * Queues the paged refresh of every existing link whose current head is the observation's
   * head in the mapped repository and, when the delivery reports its request's state, the paged
   * realignment of every link of that request. Does nothing while link recording is disabled.
   */
  readonly scheduleHeadRefresh: (input: {
    readonly digest: string;
    readonly binding: GitRepositoryIdentity;
    readonly observation: GitCheckObservation;
    readonly request: {
      readonly number: number;
      readonly state?: VerifiedGitRequestState;
    } | null;
  }) => Promise<void>;

  /** Finds earlier admitted work that can establish an authorized request link. */
  readonly findPendingRequestWork: (
    mapping: GitDeliveryMapping,
    requestNumber: number,
    triggers: readonly ('pr_open' | 'pr_head' | 'pr_updated' | 'pr_merged')[],
  ) => Promise<readonly { readonly id: string; readonly taskKeys: readonly string[] }[] | null>;

  /**
   * Stores a check observation for the mapped repository and its head, apart from any link,
   * under its provider-time watermark. Does nothing while link recording is disabled.
   */
  readonly recordCheckObservation: (
    binding: GitRepositoryIdentity,
    observation: GitCheckObservation,
  ) => Promise<void>;

  /** Records one first-seen delivery checked under the same receiver lock. */
  readonly admit: (input: {
    readonly deliveryId: string;
    readonly digest: string;
    readonly work: {
      readonly mapping: GitDeliveryMapping;
      readonly fact: Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;
      readonly prerequisiteIds?: readonly string[];
    } | null;
  }) => Promise<'accepted'>;
  // #endregion
}
