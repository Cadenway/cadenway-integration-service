import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import type { GitDeliveryMapping } from '../../../../../application/models/deliveries/git-delivery-mapping.model.js';
import { gitLinks } from '../links/git-links.schema.js';

/**
 * The one Task status intent of a verified merge per link ("Merge intent", Integration
 * AsyncAPI): `pending` until Task confirms or definitively refuses it, then `handled` with the
 * disposition or the refusal reason. It lives as long as its link.
 */
export const gitMergeIntents = pgTable(
  'git_merge_intents',
  {
    organizationId: uuid('organization_id').notNull(),
    linkId: uuid('link_id').notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    commandKey: text('command_key').notNull(),
    taskKey: text('task_key').notNull(),
    mapping: jsonb('mapping').$type<GitDeliveryMapping>().notNull(),
    targetStatus: text('target_status').$type<'done'>(),
    status: text('status').$type<'pending' | 'handled'>().notNull().default('pending'),
    disposition: text('disposition').$type<'applied' | 'no_op'>(),
    reason: text('reason'),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    /** Recovery jobs the maintenance queued after the queue exhausted an attempt's job. */
    recoveries: bigint('recoveries', { mode: 'number' }).notNull().default(0),
    /** Start of Task's receipt window: the earlier of the dispatch claim and the intent. */
    windowStartedAt: timestamp('window_started_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    reportedAt: timestamp('reported_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.linkId] }),
    foreignKey({
      columns: [table.organizationId, table.linkId],
      foreignColumns: [gitLinks.organizationId, gitLinks.id],
    }).onDelete('cascade'),
    index('git_merge_intents_pending_index')
      .on(table.windowStartedAt)
      .where(sql`${table.status} = 'pending' and ${table.reportedAt} is null`),
    check(
      'git_merge_intents_task_key_check',
      sql`${table.taskKey} ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'`,
    ),
    check(
      'git_merge_intents_command_key_check',
      sql`length(${table.commandKey}) between 1 and 255 and jsonb_typeof(${table.mapping}) = 'object'`,
    ),
    check(
      'git_merge_intents_result_check',
      sql`(${table.status} = 'pending' and ${table.disposition} is null and ${table.reason} is null and ${table.targetStatus} = 'done') or
          (${table.status} = 'handled' and (${table.disposition} is null) <> (${table.reason} is null) and (${table.disposition} is null or ${table.disposition} in ('applied', 'no_op')))`,
    ),
    check('git_merge_intents_attempts_check', sql`${table.attempts} between 0 and 1000000`),
    pgPolicy('git_merge_intents_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
