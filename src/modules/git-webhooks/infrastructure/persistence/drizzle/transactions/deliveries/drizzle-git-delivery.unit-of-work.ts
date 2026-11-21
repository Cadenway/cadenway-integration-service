import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { GitDeliveryMapping } from '../../../../../application/models/deliveries/git-delivery-mapping.model.js';
import type { GitRepositoryIdentity } from '../../../../../application/models/deliveries/git-repository-identity.model.js';
import type { GitDeliveryTransaction } from '../../../../../application/ports/outbound/transactions/deliveries/git-delivery-transaction.port.js';
import type { GitDispatchJobsProducer } from '../../../../jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import { gitRepositoryMappings } from '../../schemas/deliveries/git-repository-mappings.schema.js';
import {
  gitWebhookDeliveries,
  gitWebhookDeliveryIds,
} from '../../schemas/deliveries/git-webhook-deliveries.schema.js';

/**
 * Persists verified deliveries within the caller's tenant transaction. The caller must lock
 * and revalidate the receiver before invoking these operations.
 */
export class DrizzleGitDeliveryTransaction implements GitDeliveryTransaction {
  // #region Constructor
  /** Uses a locked receiver and its trusted tenant, never provider-supplied tenant data. */
  public constructor(
    private readonly scope: TransactionScope<DatabaseSchema>,
    private readonly organizationId: string,
    private readonly receiverId: string,
    private readonly provider: 'github' | 'gitlab',
    private readonly receiverRevision: number | null = null,
    private readonly jobs?: Pick<GitDispatchJobsProducer, 'enqueue'>,
  ) {}
  // #endregion

  // #region Methods
  /** Reads and locks the current mapping for the authenticated provider identity. */
  public async findMapping(identity: GitRepositoryIdentity): Promise<GitDeliveryMapping | null> {
    if (identity.provider !== this.provider) return null;
    const conditions = [
      eq(gitRepositoryMappings.organizationId, this.organizationId),
      eq(gitRepositoryMappings.receiverId, this.receiverId),
      eq(gitRepositoryMappings.provider, identity.provider),
      eq(gitRepositoryMappings.repositoryId, identity.repositoryId),
      eq(gitRepositoryMappings.enabled, true),
    ];
    if (identity.provider === 'github') {
      conditions.push(eq(gitRepositoryMappings.installationId, identity.installationId));
    }
    const rows = await this.scope.db
      .select()
      .from(gitRepositoryMappings)
      .where(and(...conditions))
      .limit(1)
      .for('update');
    const mapping = rows[0];
    if (mapping === undefined) return null;
    return {
      binding: identity,
      integrationId: mapping.integrationId,
      spaceId: mapping.spaceId,
      mappingAuthorUserId: mapping.mappingAuthorUserId,
    };
  }

  /** Checks an exact ID against its original authenticated digest in the caller's receiver lock. */
  public async checkDeliveryId(
    deliveryId: string,
    digest: string,
  ): Promise<'new' | 'duplicate' | 'conflict'> {
    const prior = await this.scope.db
      .select({ digest: gitWebhookDeliveries.digest })
      .from(gitWebhookDeliveryIds)
      .innerJoin(
        gitWebhookDeliveries,
        and(
          eq(gitWebhookDeliveries.organizationId, gitWebhookDeliveryIds.organizationId),
          eq(gitWebhookDeliveries.id, gitWebhookDeliveryIds.receiptId),
        ),
      )
      .where(
        and(
          eq(gitWebhookDeliveryIds.organizationId, this.organizationId),
          eq(gitWebhookDeliveryIds.receiverId, this.receiverId),
          eq(gitWebhookDeliveryIds.provider, this.provider),
          eq(gitWebhookDeliveryIds.deliveryId, deliveryId),
        ),
      )
      .limit(1);
    const original = prior[0];
    if (original === undefined) return 'new';
    return original.digest === digest ? 'duplicate' : 'conflict';
  }

  /** Records a new alias and any first work together after mapping verification under the lock. */
  public async admit(
    input: Parameters<GitDeliveryTransaction['admit']>[0],
  ): Promise<'accepted' | 'duplicate'> {
    const duplicate =
      this.provider === 'github'
        ? await this.scope.db
            .select({ id: gitWebhookDeliveries.id })
            .from(gitWebhookDeliveries)
            .where(
              and(
                eq(gitWebhookDeliveries.organizationId, this.organizationId),
                eq(gitWebhookDeliveries.receiverId, this.receiverId),
                eq(gitWebhookDeliveries.provider, this.provider),
                eq(gitWebhookDeliveries.digest, input.digest),
              ),
            )
            .limit(1)
        : [];
    const existing = duplicate[0];
    const rows =
      existing === undefined
        ? await this.scope.db
            .insert(gitWebhookDeliveries)
            .values({
              organizationId: this.organizationId,
              receiverId: this.receiverId,
              provider: this.provider,
              receiverRevision: this.receiverRevision,
              digest: input.digest,
              work: input.work,
            })
            .returning({ id: gitWebhookDeliveries.id })
        : [existing];
    const receipt = rows[0];
    if (receipt === undefined) throw new Error('The verified Git delivery was not recorded.');
    await this.scope.db.insert(gitWebhookDeliveryIds).values({
      organizationId: this.organizationId,
      receiverId: this.receiverId,
      provider: this.provider,
      deliveryId: input.deliveryId,
      receiptId: receipt.id,
    });
    if (existing === undefined && input.work !== null && this.jobs !== undefined) {
      for (const taskKey of input.work.fact.taskKeys) {
        await this.jobs.enqueue(this.scope, receipt.id, taskKey);
      }
    }
    return existing === undefined ? 'accepted' : 'duplicate';
  }
  // #endregion
}
