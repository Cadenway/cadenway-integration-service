import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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

import { gitWebhookReceivers } from './git-webhook-receivers.schema.js';

/** An organization's current Git repository to Task space authorization. */
export const gitRepositoryMappings = pgTable(
  'git_repository_mappings',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    receiverId: uuid('receiver_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    provider: text('provider').$type<'github' | 'gitlab'>().notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }),
    spaceId: uuid('space_id').notNull(),
    mappingAuthorUserId: uuid('mapping_author_user_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
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
    uniqueIndex('git_repository_mappings_github_identity_unique')
      .on(table.organizationId, table.receiverId, table.installationId, table.repositoryId)
      .where(sql`${table.provider} = 'github'`),
    uniqueIndex('git_repository_mappings_gitlab_identity_unique')
      .on(table.organizationId, table.receiverId, table.repositoryId)
      .where(sql`${table.provider} = 'gitlab'`),
    uniqueIndex('git_repository_mappings_github_global_unique')
      .on(table.receiverId, table.installationId, table.repositoryId)
      .where(sql`${table.provider} = 'github'`),
    uniqueIndex('git_repository_mappings_gitlab_global_unique')
      .on(table.receiverId, table.repositoryId)
      .where(sql`${table.provider} = 'gitlab'`),
    check(
      'git_repository_mappings_provider_check',
      sql`(${table.provider} = 'github' and ${table.installationId} is not null and ${table.installationId} > 0) or (${table.provider} = 'gitlab' and ${table.installationId} is null)`,
    ),
    check(
      'git_repository_mappings_repository_id_check',
      sql`${table.repositoryId} between 1 and 9007199254740991`,
    ),
    check(
      'git_repository_mappings_installation_id_check',
      sql`${table.installationId} is null or ${table.installationId} between 1 and 9007199254740991`,
    ),
    pgPolicy('git_repository_mappings_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
