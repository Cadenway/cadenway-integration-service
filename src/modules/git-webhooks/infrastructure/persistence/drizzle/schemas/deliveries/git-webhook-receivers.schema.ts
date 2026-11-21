import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** The durable tenant and key-generation authority for an opaque Git webhook receiver. */
export const gitWebhookReceivers = pgTable(
  'git_webhook_receivers',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    provider: text('provider').$type<'github' | 'gitlab'>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex('git_webhook_receivers_global_id_unique').on(table.id),
    uniqueIndex('git_webhook_receivers_tenant_id_provider_unique').on(
      table.organizationId,
      table.id,
      table.provider,
    ),
    check('git_webhook_receivers_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
    check(
      'git_webhook_receivers_revision_check',
      sql`${table.revision} between 1 and 9007199254740991`,
    ),
    pgPolicy('git_webhook_receivers_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
