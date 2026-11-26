import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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

import type { GitChecksAggregate } from '../../../../../domain/value-objects/checks/git-checks-aggregate.value-object.js';
import type { GitLinkIdentity } from '../../../../../domain/value-objects/links/git-link-identity.value-object.js';
import type { GitLinkMemberName } from '../../../../../domain/value-objects/links/git-link-member-name.value-object.js';
import type { GitLinkMembers } from '../../../../../domain/value-objects/links/git-link-members.value-object.js';
import type { GitLinkProjection } from '../../../../../domain/value-objects/links/git-link-projection.value-object.js';
import type { GitLinkSource } from '../../../../../domain/value-objects/links/git-link-source.value-object.js';
import { gitWebhookReceivers } from '../deliveries/git-webhook-receivers.schema.js';

/**
 * A task's provider link, scoped to its verified receiver and stable provider object, with the
 * `GitLink` projection members and the provider-time watermarks that order their updates.
 * `checks_attempt_id` is no longer written; a later contract migration removes it.
 */
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
    status: text('status').$type<GitLinkProjection['status']>().notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    headSha: text('head_sha'),
    headFirstObservedAtMs: bigint('head_first_observed_at_ms', { mode: 'number' }),
    headLastObservedAtMs: bigint('head_last_observed_at_ms', { mode: 'number' }),
    checksAttemptId: bigint('checks_attempt_id', { mode: 'number' }),
    checksCompletedAtMs: bigint('checks_completed_at_ms', { mode: 'number' }),
    checks: jsonb('checks').$type<GitChecksAggregate>(),
    lifecycleObservedAtMs: bigint('lifecycle_observed_at_ms', { mode: 'number' }),
    lifecycleAdmissionSequence: bigint('lifecycle_admission_sequence', { mode: 'number' }),
    headAdmissionSequence: bigint('head_admission_sequence', { mode: 'number' }),
    title: text('title'),
    draft: boolean('draft'),
    url: text('url'),
    repository: jsonb('repository').$type<NonNullable<GitLinkMembers['repository']>>(),
    sourceBranch: text('source_branch'),
    author: jsonb('author').$type<NonNullable<GitLinkMembers['author']>>(),
    reviewRequested: boolean('review_requested'),
    additions: bigint('additions', { mode: 'number' }),
    deletions: bigint('deletions', { mode: 'number' }),
    linkSource: text('link_source').$type<GitLinkSource>(),
    memberObservedAtMs: jsonb('member_observed_at_ms')
      .$type<Partial<Record<GitLinkMemberName, number>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    memberAdmissionSequence: jsonb('member_admission_sequence')
      .$type<Partial<Record<GitLinkMemberName, number>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    reconciliationPendingSince: timestamp('reconciliation_pending_since', {
      withTimezone: true,
      precision: 3,
    }),
    reconciliationReportedAt: timestamp('reconciliation_reported_at', {
      withTimezone: true,
      precision: 3,
    }),
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
    index('git_links_task_page_index').on(
      table.organizationId,
      table.taskKey,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('git_links_head_lookup_index')
      .on(table.organizationId, table.receiverId, table.headSha)
      .where(sql`${table.headSha} is not null`),
    index('git_links_reconciliation_index')
      .on(table.reconciliationPendingSince)
      .where(
        sql`${table.reconciliationPendingSince} is not null and ${table.reconciliationReportedAt} is null`,
      ),
    index('git_links_request_lookup_index').on(
      table.organizationId,
      table.receiverId,
      table.identityHash,
      table.taskKey,
    ),
    check('git_links_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
    check('git_links_task_key_check', sql`${table.taskKey} ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'`),
    check('git_links_identity_hash_check', sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`),
    check('git_links_identity_check', sql`jsonb_typeof(${table.identity}) = 'object'`),
    check(
      'git_links_head_check',
      sql`(${table.headSha} is null and ${table.headFirstObservedAtMs} is null and ${table.headLastObservedAtMs} is null) or
          (${table.headSha} is not null and ${table.headFirstObservedAtMs} is not null and ${table.headLastObservedAtMs} is not null and ${table.headSha} ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' and ${table.headFirstObservedAtMs} between 0 and 9007199254740991 and ${table.headLastObservedAtMs} between ${table.headFirstObservedAtMs} and 9007199254740991)`,
    ),
    check(
      'git_links_checks_completed_check',
      sql`${table.checksCompletedAtMs} is null or ${table.checksCompletedAtMs} between 0 and 9007199254740991`,
    ),
    check(
      'git_links_aggregate_check',
      sql`${table.checks} is null or (${table.headSha} is not null and jsonb_typeof(${table.checks}) = 'object')`,
    ),
    check(
      'git_links_lifecycle_observed_check',
      sql`${table.lifecycleObservedAtMs} is null or ${table.lifecycleObservedAtMs} between 0 and 9007199254740991`,
    ),
    check(
      'git_links_line_counts_check',
      sql`(${table.additions} is null or ${table.additions} between 0 and 9007199254740991) and (${table.deletions} is null or ${table.deletions} between 0 and 9007199254740991)`,
    ),
    check(
      'git_links_link_source_check',
      sql`${table.linkSource} is null or ${table.linkSource} in ('branch', 'title', 'description', 'commit')`,
    ),
    check(
      'git_links_members_check',
      sql`jsonb_typeof(${table.memberObservedAtMs}) = 'object' and (${table.repository} is null or jsonb_typeof(${table.repository}) = 'object') and (${table.author} is null or jsonb_typeof(${table.author}) = 'object')`,
    ),
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
