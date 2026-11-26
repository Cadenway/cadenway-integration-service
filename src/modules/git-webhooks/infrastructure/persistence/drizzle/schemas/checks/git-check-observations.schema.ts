import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { gitWebhookReceivers } from '../deliveries/git-webhook-receivers.schema.js';

/**
 * Latest verified state of each check suite or merge request pipeline per organization,
 * connected repository and head SHA, independent of any link ("Checks", Integration AsyncAPI).
 * A row whose head is no link's current head is pruned 7 days after its own last update.
 */
export const gitCheckObservations = pgTable(
  'git_check_observations',
  {
    organizationId: uuid('organization_id').notNull(),
    receiverId: uuid('receiver_id').notNull(),
    provider: text('provider').$type<'github' | 'gitlab'>().notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    headSha: text('head_sha').notNull(),
    attemptId: bigint('attempt_id', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    jobTotal: bigint('job_total', { mode: 'number' }),
    jobFailed: bigint('job_failed', { mode: 'number' }),
    observedAtMs: bigint('observed_at_ms', { mode: 'number' }).notNull(),
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.receiverId,
        table.repositoryId,
        table.headSha,
        table.attemptId,
      ],
    }),
    foreignKey({
      columns: [table.organizationId, table.receiverId, table.provider],
      foreignColumns: [
        gitWebhookReceivers.organizationId,
        gitWebhookReceivers.id,
        gitWebhookReceivers.provider,
      ],
    }),
    index('git_check_observations_updated_index').on(table.updatedAt),
    check('git_check_observations_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
    check(
      'git_check_observations_identity_check',
      sql`${table.repositoryId} between 1 and 9007199254740991 and ${table.attemptId} between 1 and 9007199254740991 and ${table.headSha} ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      'git_check_observations_status_check',
      sql`(${table.provider} = 'github' and ${table.status} in ('requested', 'queued', 'in_progress', 'pending', 'waiting', 'completed') and ${table.jobTotal} is null and ${table.jobFailed} is null and ((${table.status} = 'completed') = (${table.conclusion} is not null))) or
          (${table.provider} = 'gitlab' and ${table.status} in ('created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'success', 'failed', 'canceled', 'skipped') and ${table.conclusion} is null)`,
    ),
    check(
      'git_check_observations_times_check',
      sql`${table.observedAtMs} between 0 and 9007199254740991 and (${table.completedAtMs} is null or ${table.completedAtMs} between 0 and 9007199254740991) and (${table.jobTotal} is null or ${table.jobTotal} between 0 and 9007199254740991) and (${table.jobFailed} is null or ${table.jobFailed} between 0 and ${table.jobTotal})`,
    ),
    pgPolicy('git_check_observations_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
