import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { GitDeliveryMapping } from '../../../../../application/models/deliveries/git-delivery-mapping.model.js';
import { gitMergeIntents } from '../../schemas/merges/git-merge-intents.schema.js';

/** Records the first merge intent of a link inside the transaction that holds the link lock. */
export class DrizzleGitMergeIntentRepository {
  // #region Methods
  /**
   * Creates the link's intent unless one exists ("Merge intent", Integration AsyncAPI). A merge
   * without a status to apply is recorded `handled` at once, and so is one whose status Task
   * already confirmed with the dispatch itself (`confirmed`). Returns whether an attempt is due.
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
      readonly confirmed?: 'applied' | 'no_op';
    },
  ): Promise<'pending' | 'handled' | 'existing'> {
    if (scope.kind !== 'tenant' || scope.organizationId !== input.organizationId) {
      throw new Error('Merge intent does not belong to the tenant transaction.');
    }
    const pending = input.targetStatus !== null && input.confirmed === undefined;
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
        disposition: input.targetStatus === null ? null : (input.confirmed ?? null),
        reason: input.targetStatus === null ? 'no-status-intent' : null,
        // The command key is the dispatch claim's UUIDv7: Task may hold its receipt since then.
        windowStartedAt: sql`least(now(), ${new Date(windowStart(input.commandKey)).toISOString()}::timestamptz)`,
        updatedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ status: gitMergeIntents.status });
    const row = inserted[0];
    return row === undefined ? 'existing' : row.status;
  }
  // #endregion
}

/** Reads the creation time of a UUIDv7 command key, or now for another key. */
function windowStart(commandKey: string): number {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(commandKey)
    ? Number.parseInt(commandKey.slice(0, 8) + commandKey.slice(9, 13), 16)
    : Date.now();
}
