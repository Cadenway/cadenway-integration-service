import { sql } from 'drizzle-orm';
import { check, pgPolicy, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Terminal task keys prevent late Git deliveries recreating links after Task purges them. */
export const gitPurgedTasks = pgTable(
  'git_purged_tasks',
  {
    organizationId: uuid('organization_id').notNull(),
    taskKey: text('task_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.taskKey] }),
    check('git_purged_tasks_key_check', sql`${table.taskKey} ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'`),
    pgPolicy('git_purged_tasks_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
