import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { GitDeliveryMapping } from '../../../../../application/models/deliveries/git-delivery-mapping.model.js';
import { gitWebhookDeliveries } from '../../schemas/deliveries/git-webhook-deliveries.schema.js';
import { gitDispatchClaims } from '../../schemas/dispatch/git-dispatch-claims.schema.js';

/** Finds earlier admitted work that must settle before another request update. */
export class DrizzleGitRequestPredecessorsRepository {
  // #region Methods
  /** Returns null when the bounded predecessor set is too large to preserve. */
  public async findPending(
    scope: TransactionScope<DatabaseSchema>,
    input: {
      readonly organizationId: string;
      readonly receiverId: string;
      readonly receiverRevision: number;
      readonly mapping: GitDeliveryMapping;
      readonly requestNumber: number;
      readonly triggers: readonly ('pr_open' | 'pr_head' | 'pr_merged')[];
    },
  ): Promise<readonly { readonly id: string; readonly taskKeys: readonly string[] }[] | null> {
    if (scope.kind !== 'tenant' || scope.organizationId !== input.organizationId) {
      throw new Error('Git predecessor lookup does not belong to the tenant transaction.');
    }
    if (input.triggers.length === 0) return [];
    const work = gitWebhookDeliveries.work;
    const { binding } = input.mapping;
    const predicates = [
      eq(gitWebhookDeliveries.organizationId, input.organizationId),
      eq(gitWebhookDeliveries.receiverId, input.receiverId),
      eq(gitWebhookDeliveries.receiverRevision, input.receiverRevision),
      eq(gitWebhookDeliveries.provider, binding.provider),
      sql`${work} -> 'recordLink' = 'true'::jsonb`,
      sql`${work} -> 'mapping' ->> 'integrationId' = ${input.mapping.integrationId}`,
      sql`${work} -> 'mapping' ->> 'spaceId' = ${input.mapping.spaceId}`,
      sql`${work} -> 'mapping' ->> 'mappingAuthorUserId' = ${input.mapping.mappingAuthorUserId}`,
      sql`${work} -> 'mapping' -> 'binding' ->> 'provider' = ${binding.provider}`,
      sql`${work} -> 'mapping' -> 'binding' ->> 'repositoryId' = ${String(binding.repositoryId)}`,
      sql`${work} -> 'fact' ->> 'requestNumber' = ${String(input.requestNumber)}`,
      inArray(sql<string>`${work} -> 'fact' ->> 'trigger'`, input.triggers),
      sql`${gitWebhookDeliveries.createdAt} > now() - interval '1 hour'`,
      sql`exists (
        select 1
          from jsonb_array_elements_text(
            case when jsonb_typeof(${work} -> 'fact' -> 'taskKeys') = 'array'
              then ${work} -> 'fact' -> 'taskKeys' else '[]'::jsonb end
          ) as target(task_key)
         where not exists (
           select 1 from ${gitDispatchClaims}
            where ${gitDispatchClaims.organizationId} = ${input.organizationId}
              and ${gitDispatchClaims.deliveryId} = ${gitWebhookDeliveries.id}
              and ${gitDispatchClaims.taskKey} = target.task_key
              and ${gitDispatchClaims.status} in ('completed', 'closed')
         )
      )`,
    ];
    if (binding.provider === 'github') {
      predicates.push(
        sql`${work} -> 'mapping' -> 'binding' ->> 'installationId' = ${String(binding.installationId)}`,
      );
    }
    const rows = await scope.db
      .select({ id: gitWebhookDeliveries.id, work })
      .from(gitWebhookDeliveries)
      .where(and(...predicates))
      .orderBy(gitWebhookDeliveries.createdAt, gitWebhookDeliveries.id)
      .limit(21);
    if (rows.length > 20) return null;
    return rows.flatMap((row) =>
      row.work === null ? [] : [{ id: row.id, taskKeys: row.work.fact.taskKeys }],
    );
  }

  /** Checks whether a saved predecessor still needs to settle the same task. */
  public async hasPendingForTask(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    prerequisiteIds: readonly string[],
    taskKey: string,
  ): Promise<boolean> {
    if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
      throw new Error('Git predecessor lookup does not belong to the tenant transaction.');
    }
    if (prerequisiteIds.length > 20) throw new Error('Git predecessor set exceeds its bound.');
    if (prerequisiteIds.length === 0) return false;
    const rows = await scope.db
      .select({ id: gitWebhookDeliveries.id })
      .from(gitWebhookDeliveries)
      .where(
        and(
          eq(gitWebhookDeliveries.organizationId, organizationId),
          inArray(gitWebhookDeliveries.id, prerequisiteIds),
          sql`${gitWebhookDeliveries.work} -> 'fact' -> 'taskKeys' ? ${taskKey}`,
          sql`not exists (
            select 1 from ${gitDispatchClaims}
             where ${gitDispatchClaims.organizationId} = ${organizationId}
               and ${gitDispatchClaims.deliveryId} = ${gitWebhookDeliveries.id}
               and ${gitDispatchClaims.taskKey} = ${taskKey}
               and ${gitDispatchClaims.status} in ('completed', 'closed')
          )`,
        ),
      )
      .limit(1);
    return rows.length !== 0;
  }
  // #endregion
}
