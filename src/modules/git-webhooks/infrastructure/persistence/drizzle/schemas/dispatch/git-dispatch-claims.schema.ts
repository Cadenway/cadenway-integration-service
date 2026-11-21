import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { gitWebhookDeliveries } from '../deliveries/git-webhook-deliveries.schema.js';

/** Durable Task command identity and terminal placement for one admitted delivery target. */
export const gitDispatchClaims = pgTable(
  'git_dispatch_claims',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    deliveryId: uuid('delivery_id').notNull(),
    taskKey: text('task_key').notNull(),
    status: text('status').$type<'pending' | 'completed' | 'closed'>().notNull().default('pending'),
    disposition: text('disposition').$type<'applied' | 'no_op'>(),
    taskId: uuid('task_id'),
    listId: uuid('list_id'),
    spaceId: uuid('space_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex('git_dispatch_claims_delivery_task_unique').on(
      table.organizationId,
      table.deliveryId,
      table.taskKey,
    ),
    foreignKey({
      columns: [table.organizationId, table.deliveryId],
      foreignColumns: [gitWebhookDeliveries.organizationId, gitWebhookDeliveries.id],
    }),
    check(
      'git_dispatch_claims_task_key_check',
      sql`${table.taskKey} ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'`,
    ),
    check(
      'git_dispatch_claims_result_check',
      sql`(${table.status} = 'completed' and ${table.disposition} is not null and ${table.disposition} in ('applied','no_op') and ${table.taskId} is not null and ${table.listId} is not null and ${table.spaceId} is not null) or (${table.status} in ('pending','closed') and ${table.disposition} is null and ${table.taskId} is null and ${table.listId} is null and ${table.spaceId} is null)`,
    ),
    pgPolicy('git_dispatch_claims_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
