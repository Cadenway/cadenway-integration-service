import { sql } from 'drizzle-orm';
import {
  check,
  bigint,
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

import type { GitDeliveryMapping } from '../../../../../application/models/deliveries/git-delivery-mapping.model.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';
import { gitWebhookReceivers } from './git-webhook-receivers.schema.js';

/** A verified provider delivery and its immutable, bounded work description. */
export const gitWebhookDeliveries = pgTable(
  'git_webhook_deliveries',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    receiverId: uuid('receiver_id').notNull(),
    provider: text('provider').$type<'github' | 'gitlab'>().notNull(),
    receiverRevision: bigint('receiver_revision', { mode: 'number' }),
    digest: text('digest').notNull(),
    work: jsonb('work').$type<{
      readonly mapping: GitDeliveryMapping;
      readonly fact: Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;
      readonly prerequisiteIds?: readonly string[];
      readonly recordLink?: true;
      /** Set since link recording keeps the merge status as the link's merge intent. */
      readonly mergeIntent?: true;
    } | null>(),
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
    uniqueIndex('git_webhook_deliveries_receipt_owner_unique').on(
      table.organizationId,
      table.receiverId,
      table.provider,
      table.id,
    ),
    uniqueIndex('git_webhook_deliveries_github_digest_unique')
      .on(table.organizationId, table.receiverId, table.digest)
      .where(sql`${table.provider} = 'github'`),
    index('git_webhook_deliveries_request_predecessors_index').on(
      table.organizationId,
      table.receiverId,
      table.provider,
      sql`(${table.work} -> 'fact' ->> 'requestNumber')`,
      table.createdAt,
      table.id,
    ),
    check('git_webhook_deliveries_provider_check', sql`${table.provider} in ('github', 'gitlab')`),
    check(
      'git_webhook_deliveries_receiver_revision_check',
      sql`${table.receiverRevision} is null or ${table.receiverRevision} between 1 and 9007199254740991`,
    ),
    check('git_webhook_deliveries_digest_check', sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'git_webhook_deliveries_work_check',
      sql`${table.work} is null or jsonb_typeof(${table.work}) = 'object'`,
    ),
    pgPolicy('git_webhook_deliveries_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();

/** First-seen provider delivery IDs and historical aliases that still fence conflicting IDs. */
export const gitWebhookDeliveryIds = pgTable(
  'git_webhook_delivery_ids',
  {
    organizationId: uuid('organization_id').notNull(),
    receiverId: uuid('receiver_id').notNull(),
    provider: text('provider').$type<'github' | 'gitlab'>().notNull(),
    deliveryId: text('delivery_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.receiverId, table.provider, table.deliveryId],
    }),
    foreignKey({
      columns: [table.organizationId, table.receiverId, table.provider, table.receiptId],
      foreignColumns: [
        gitWebhookDeliveries.organizationId,
        gitWebhookDeliveries.receiverId,
        gitWebhookDeliveries.provider,
        gitWebhookDeliveries.id,
      ],
    }),
    check(
      'git_webhook_delivery_ids_provider_check',
      sql`${table.provider} in ('github', 'gitlab')`,
    ),
    check(
      'git_webhook_delivery_ids_length_check',
      sql`length(${table.deliveryId}) between 1 and 255`,
    ),
    pgPolicy('git_webhook_delivery_ids_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
