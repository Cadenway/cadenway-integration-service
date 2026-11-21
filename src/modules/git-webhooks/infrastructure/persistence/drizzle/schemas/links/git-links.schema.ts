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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { GitLinkIdentity } from '../../../../../domain/value-objects/links/git-link-identity.value-object.js';
import type { GitLinkState } from '../../../../../domain/value-objects/links/git-link-state.value-object.js';
import { gitWebhookReceivers } from '../deliveries/git-webhook-receivers.schema.js';

/** A task's provider link, scoped to its verified receiver and stable provider object. */
export const gitLinks = pgTable(
  'git_links',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    receiverId: uuid('receiver_id').notNull(),
    provider: text('provider').$type<'github' | 'gitlab'>().notNull(),
    taskId: uuid('task_id').notNull(),
    taskKey: text('task_key').notNull(),
    identityHash: text('identity_hash').notNull(),
    identity: jsonb('identity').$type<GitLinkIdentity>().notNull(),
    status: text('status').$type<GitLinkState['status']>().notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.receiverId, table.provider],
      foreignColumns: [
        gitWebhookReceivers.organizationId,
        gitWebhookReceivers.id,
        gitWebhookReceivers.provider,
      ],
    }),
    uniqueIndex('git_links_identity_unique').on(
      table.organizationId,
      table.receiverId,
      table.taskId,
      table.identityHash,
    ),
    index('git_links_tenant_task_index').on(table.organizationId, table.taskId, table.id),
    index('git_links_tenant_task_key_index').on(table.organizationId, table.taskKey, table.id),
    check('git_links_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
    check('git_links_task_key_check', sql`${table.taskKey} ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'`),
    check('git_links_identity_hash_check', sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`),
    check('git_links_identity_check', sql`jsonb_typeof(${table.identity}) = 'object'`),
    check(
      'git_links_status_check',
      sql`${table.status} in ('created', 'open', 'merged', 'closed')`,
    ),
    check('git_links_version_check', sql`${table.version} between 1 and 9007199254740991`),
    pgPolicy('git_links_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
