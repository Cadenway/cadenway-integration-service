import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { GitDeliveryMapping } from '../../../../../application/models/deliveries/git-delivery-mapping.model.js';
import { gitMergeIntents } from '../../schemas/merges/git-merge-intents.schema.js';

/** Records the first merge intent of a link inside the transaction that holds the link lock. */
export class DrizzleGitMergeIntentRepository {
  // #region Methods
  /**
   * Creates the link's intent unless one exists ("Merge intent", Integration AsyncAPI). A merge
   * without a status to apply is recorded `handled` at once. Returns whether an attempt is due.
   */
  public async recordFirst(
    scope: TransactionScope<DatabaseSchema>,
    input: {
      readonly organizationId: string;
      readonly linkId: string;
      readonly deliveryId: string;
      readonly commandKey: string;
      readonly taskKey: string;
      readonly mapping: GitDeliveryMapping;
      readonly targetStatus: 'done' | null;
    },
  ): Promise<'pending' | 'handled' | 'existing'> {
    if (scope.kind !== 'tenant' || scope.organizationId !== input.organizationId) {
      throw new Error('Merge intent does not belong to the tenant transaction.');
    }
    const pending = input.targetStatus !== null;
    const inserted = await scope.db
      .insert(gitMergeIntents)
      .values({
        organizationId: input.organizationId,
        linkId: input.linkId,
        deliveryId: input.deliveryId,
        commandKey: input.commandKey,
        taskKey: input.taskKey,
        mapping: input.mapping,
        targetStatus: input.targetStatus,
        status: pending ? 'pending' : 'handled',
        reason: pending ? null : 'no-status-intent',
        updatedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ status: gitMergeIntents.status });
    const row = inserted[0];
    return row === undefined ? 'existing' : row.status;
  }
  // #endregion
}
