import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';

import type { GitWebhookBindingStore } from '../../../../../application/ports/outbound/persistence/bindings/git-webhook-binding-store.port.js';
import type { GitWebhookBindingUnitOfWork } from '../../../../../application/ports/outbound/transactions/bindings/git-webhook-binding-unit-of-work.port.js';
import type { ManageGitWebhookBindingInput } from '../../../../../application/use-cases/commands/bindings/manage-git-webhook-binding/manage-git-webhook-binding.input.js';
import { gitRepositoryMappings } from '../../schemas/deliveries/git-repository-mappings.schema.js';
import { gitWebhookReceivers } from '../../schemas/deliveries/git-webhook-receivers.schema.js';

/** Operates on Integration's own binding records through the application database role. */
export class DrizzleGitWebhookBindingUnitOfWork implements GitWebhookBindingUnitOfWork {
  // #region Constructor
  /** Binds the application's tenant transaction runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Opens only PostgreSQL for the operator command and closes it on completion. */
  public static async withConnection<T>(
    connectionString: string,
    execute: (work: GitWebhookBindingUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const pool = new pg.Pool({
      connectionString,
      application_name: 'integration-git-binding',
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    try {
      return await execute(
        new DrizzleGitWebhookBindingUnitOfWork(new TenantTransactionRunner(pool)),
      );
    } finally {
      await pool.end();
    }
  }

  /** Establishes tenant scope explicitly before acquiring any SQL locks. */
  public run<T>(
    organizationId: string,
    operation: (store: GitWebhookBindingStore) => Promise<T>,
  ): Promise<T> {
    return runWithOrganizationContext(
      {
        organizationId,
        actor: { type: 'system', id: 'integration-service' },
        role: null,
        scopes: [],
      },
      () => this.runner.run((scope) => operation(createBindingStore(scope))),
    );
  }
  // #endregion
}

function receiverWhere(input: ManageGitWebhookBindingInput) {
  return and(
    eq(gitWebhookReceivers.organizationId, input.organizationId),
    eq(gitWebhookReceivers.id, input.bindingId),
    eq(gitWebhookReceivers.provider, input.provider),
  );
}

function createBindingStore(scope: TransactionScope<DatabaseSchema>): GitWebhookBindingStore {
  return {
    async insertReceiver({ organizationId, bindingId, provider, revision }) {
      await scope.db
        .insert(gitWebhookReceivers)
        .values({ organizationId, id: bindingId, provider, revision })
        .onConflictDoNothing();
    },
    async lockReceiver(input) {
      const [current] = await scope.db
        .select({ revision: gitWebhookReceivers.revision, enabled: gitWebhookReceivers.enabled })
        .from(gitWebhookReceivers)
        .where(receiverWhere(input))
        .limit(1)
        .for('update');
      return current ?? null;
    },
    async registerMapping(input) {
      const {
        organizationId,
        bindingId,
        provider,
        repositoryId,
        installationId,
        integrationId,
        spaceId,
        mappingAuthorUserId,
      } = input;
      await scope.db
        .insert(gitRepositoryMappings)
        .values({
          organizationId,
          receiverId: bindingId,
          provider,
          repositoryId,
          installationId,
          integrationId,
          spaceId,
          mappingAuthorUserId,
        })
        .onConflictDoNothing();
      const [mapping] = await scope.db
        .select({
          integrationId: gitRepositoryMappings.integrationId,
          spaceId: gitRepositoryMappings.spaceId,
          mappingAuthorUserId: gitRepositoryMappings.mappingAuthorUserId,
          enabled: gitRepositoryMappings.enabled,
        })
        .from(gitRepositoryMappings)
        .where(
          and(
            eq(gitRepositoryMappings.organizationId, organizationId),
            eq(gitRepositoryMappings.receiverId, bindingId),
            eq(gitRepositoryMappings.provider, provider),
            eq(gitRepositoryMappings.repositoryId, repositoryId),
            installationId === null
              ? isNull(gitRepositoryMappings.installationId)
              : eq(gitRepositoryMappings.installationId, installationId),
          ),
        )
        .limit(1);
      return (
        mapping !== undefined &&
        mapping.enabled &&
        mapping.integrationId === integrationId &&
        mapping.spaceId === spaceId &&
        mapping.mappingAuthorUserId === mappingAuthorUserId
      );
    },
    async updateReceiver(input, state) {
      await scope.db
        .update(gitWebhookReceivers)
        .set({ ...state, updatedAt: new Date() })
        .where(receiverWhere(input));
    },
  };
}
