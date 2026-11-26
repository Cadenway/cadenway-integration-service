import { runWithOrganizationContext } from '@cadenway/nest-common';
import type {
  DatabaseSchema,
  TenantTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { GitDispatchClaim } from '../../../../../application/models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskActionResult } from '../../../../../application/models/dispatch/git-task-action-result.model.js';
import type { GitDispatchUnitOfWork } from '../../../../../application/ports/outbound/transactions/dispatch/git-dispatch-unit-of-work.port.js';
import type { decideGitCheckPrerequisites } from '../../../../../application/models/dispatch/git-check-prerequisites.model.js';
import type { GitDispatchJobsProducer } from '../../../../jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import { DrizzleGitRequestPredecessorsRepository } from '../../repositories/deliveries/drizzle-git-request-predecessors.repository.js';
import { gitRepositoryMappings } from '../../schemas/deliveries/git-repository-mappings.schema.js';
import { gitWebhookDeliveries } from '../../schemas/deliveries/git-webhook-deliveries.schema.js';
import { gitWebhookReceivers } from '../../schemas/deliveries/git-webhook-receivers.schema.js';
import { gitDispatchClaims } from '../../schemas/dispatch/git-dispatch-claims.schema.js';

type Delivery = typeof gitWebhookDeliveries.$inferSelect;
type Claim = typeof gitDispatchClaims.$inferSelect;

/** Reserves and settles Task commands in short transactions with current mapping authority. */
export class DrizzleGitDispatchUnitOfWork implements GitDispatchUnitOfWork {
  // #region Constructor
  /** Uses the service's tenant transaction runner. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly recordLink?: (
      scope: TransactionScope<DatabaseSchema>,
      claim: GitDispatchClaim,
      receiverId: string,
      placement: Exclude<GitTaskActionResult, { readonly disposition: 'unavailable' }>,
    ) => Promise<void>,
    private readonly checkContinuation?: {
      readonly decide: typeof decideGitCheckPrerequisites;
      readonly jobs: Pick<GitDispatchJobsProducer, 'enqueue'>;
    },
  ) {}
  // #endregion

  // #region Methods
  /** Reserves a stable command key or restores the existing target decision. */
  public prepare(
    input: Parameters<GitDispatchUnitOfWork['prepare']>[0],
  ): ReturnType<GitDispatchUnitOfWork['prepare']> {
    return this.inTenant(input.organizationId, async (scope) => {
      const delivery = await this.lockAuthority(scope, input.organizationId, input.deliveryId);
      const existing = await this.findClaim(
        scope,
        input.organizationId,
        input.deliveryId,
        input.taskKey,
      );
      if (existing?.status === 'completed') return { status: 'completed' };
      if (existing?.status === 'closed') return { status: 'closed' };
      if (!delivery?.work?.fact.taskKeys.includes(input.taskKey)) {
        if (existing !== null) await this.close(scope, input.organizationId, existing.id);
        return { status: 'closed' };
      }
      const prerequisites = await this.preparePrerequisites(scope, input, delivery.work);
      if (prerequisites === 'deferred') return { status: 'deferred' };
      const rows =
        existing === null
          ? await scope.db
              .insert(gitDispatchClaims)
              .values({
                organizationId: input.organizationId,
                deliveryId: input.deliveryId,
                taskKey: input.taskKey,
                ...(prerequisites === 'closed' ? { status: 'closed' as const } : {}),
              })
              .onConflictDoNothing()
              .returning()
          : [existing];
      const claim =
        rows[0] ??
        (await this.findClaim(scope, input.organizationId, input.deliveryId, input.taskKey));
      if (claim === null) throw new Error('The Git dispatch claim was not recorded.');
      if (claim.status !== 'pending') return { status: claim.status };
      if (prerequisites === 'closed') {
        await this.close(scope, input.organizationId, claim.id);
        return { status: 'closed' };
      }
      if (delivery.receiverRevision === null)
        throw new Error('The verified receiver revision is missing.');
      return { status: 'ready', claim: this.toClaim(delivery, claim) };
    });
  }

  /** Atomically defers a blocked check while the receiver and mapping are locked. */
  private async preparePrerequisites(
    scope: TransactionScope<DatabaseSchema>,
    input: Parameters<GitDispatchUnitOfWork['prepare']>[0],
    work: NonNullable<Delivery['work']>,
  ): Promise<'ready' | 'closed' | 'deferred'> {
    if (work.prerequisiteIds === undefined) return 'ready';
    const unsettled = await new DrizzleGitRequestPredecessorsRepository().findUnsettledForTask(
      scope,
      input.organizationId,
      work.prerequisiteIds,
      input.taskKey,
    );
    if (work.fact.trigger !== 'pr_checks') {
      if (unsettled.length !== 0) throw new Error('An earlier Git request action has not settled.');
      return 'ready';
    }
    const continuation = this.checkContinuation;
    if (continuation === undefined)
      throw new Error('The Git dispatch continuation is not configured.');
    const clock = await scope.db.execute<{ readonly now: number }>(
      sql`select floor(extract(epoch from clock_timestamp()) * 1000)::double precision as now`,
    );
    const now = clock.rows[0]?.now;
    if (now === undefined) throw new Error('The Git dispatch clock is unavailable.');
    const decision = continuation.decide(input.deliveryId, unsettled, now);
    if (decision.status !== 'deferred') return decision.status;
    await continuation.jobs.enqueue(
      scope,
      input.deliveryId,
      input.taskKey,
      work.recordLink === true,
      decision.startAfter,
    );
    return 'deferred';
  }

  /** Rechecks authority and records a terminal Task result with the verified placement. */
  public finish(
    input: Parameters<GitDispatchUnitOfWork['finish']>[0],
  ): ReturnType<GitDispatchUnitOfWork['finish']> {
    return this.inTenant(input.organizationId, async (scope) => {
      const delivery = await this.lockAuthority(scope, input.organizationId, input.deliveryId);
      const stored = await this.findClaim(
        scope,
        input.organizationId,
        input.deliveryId,
        input.claim.taskKey,
      );
      if (stored?.id !== input.claim.commandKey) return 'closed';
      if (stored.status !== 'pending') return stored.status;
      if (
        delivery?.receiverRevision !== input.claim.receiverRevision ||
        !delivery.work?.fact.taskKeys.includes(stored.taskKey) ||
        input.result.disposition === 'unavailable' ||
        input.result.spaceId !== delivery.work.mapping.spaceId
      ) {
        await this.close(scope, input.organizationId, stored.id);
        return 'closed';
      }
      if (delivery.work.recordLink === true) {
        await this.recordLink?.(scope, input.claim, delivery.receiverId, input.result);
      }
      await scope.db
        .update(gitDispatchClaims)
        .set({
          status: 'completed',
          disposition: input.result.disposition,
          taskId: input.result.taskId,
          listId: input.result.listId,
          spaceId: input.result.spaceId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(gitDispatchClaims.organizationId, input.organizationId),
            eq(gitDispatchClaims.id, stored.id),
          ),
        );
      return 'completed';
    });
  }

  /** Runs with the authoritative tenant rather than a provider-supplied organization. */
  private inTenant<T>(
    organizationId: string,
    work: (scope: TransactionScope<DatabaseSchema>) => Promise<T>,
  ): Promise<T> {
    return runWithOrganizationContext(
      {
        organizationId,
        actor: { type: 'system', id: 'integration-service' },
        role: null,
        scopes: [],
      },
      () => this.runner.run(work),
    );
  }

  /** Locks the receiver before its current mapping, in the same order as webhook admission. */
  private async lockAuthority(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    deliveryId: string,
  ): Promise<Delivery | null> {
    const rows = await scope.db
      .select()
      .from(gitWebhookDeliveries)
      .where(
        and(
          eq(gitWebhookDeliveries.organizationId, organizationId),
          eq(gitWebhookDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    const delivery = rows[0];
    if (
      delivery?.work === null ||
      delivery?.work === undefined ||
      delivery.receiverRevision === null
    )
      return null;
    const receiver = await scope.db
      .select({ id: gitWebhookReceivers.id })
      .from(gitWebhookReceivers)
      .where(
        and(
          eq(gitWebhookReceivers.organizationId, organizationId),
          eq(gitWebhookReceivers.id, delivery.receiverId),
          eq(gitWebhookReceivers.provider, delivery.provider),
          eq(gitWebhookReceivers.revision, delivery.receiverRevision),
          eq(gitWebhookReceivers.enabled, true),
        ),
      )
      .limit(1)
      .for('update');
    if (receiver.length === 0) return null;
    const identity = delivery.work.mapping.binding;
    if (identity.provider !== delivery.provider) return null;
    const conditions = [
      eq(gitRepositoryMappings.organizationId, organizationId),
      eq(gitRepositoryMappings.receiverId, delivery.receiverId),
      eq(gitRepositoryMappings.provider, identity.provider),
      eq(gitRepositoryMappings.repositoryId, identity.repositoryId),
      eq(gitRepositoryMappings.integrationId, delivery.work.mapping.integrationId),
      eq(gitRepositoryMappings.spaceId, delivery.work.mapping.spaceId),
      eq(gitRepositoryMappings.mappingAuthorUserId, delivery.work.mapping.mappingAuthorUserId),
      eq(gitRepositoryMappings.enabled, true),
    ];
    if (identity.provider === 'github')
      conditions.push(eq(gitRepositoryMappings.installationId, identity.installationId));
    const mapping = await scope.db
      .select({ id: gitRepositoryMappings.id })
      .from(gitRepositoryMappings)
      .where(and(...conditions))
      .limit(1)
      .for('update');
    return mapping.length === 0 ? null : delivery;
  }

  /** Locks a target claim so concurrent completions cannot overwrite a terminal result. */
  private async findClaim(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    deliveryId: string,
    taskKey: string,
  ): Promise<Claim | null> {
    const rows = await scope.db
      .select()
      .from(gitDispatchClaims)
      .where(
        and(
          eq(gitDispatchClaims.organizationId, organizationId),
          eq(gitDispatchClaims.deliveryId, deliveryId),
          eq(gitDispatchClaims.taskKey, taskKey),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** Keeps a revoked or unavailable target terminal without a placement. */
  private async close(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    id: string,
  ): Promise<void> {
    await scope.db
      .update(gitDispatchClaims)
      .set({ status: 'closed', updatedAt: sql`now()` })
      .where(
        and(
          eq(gitDispatchClaims.organizationId, organizationId),
          eq(gitDispatchClaims.id, id),
          eq(gitDispatchClaims.status, 'pending'),
        ),
      );
  }

  /** Builds the Task command solely from the admitted snapshot and durable identity. */
  private toClaim(delivery: Delivery, row: Claim): GitDispatchClaim {
    if (delivery.work === null || delivery.receiverRevision === null)
      throw new Error('Invalid Git dispatch snapshot.');
    return {
      organizationId: row.organizationId,
      deliveryId: row.deliveryId,
      admissionSequence: delivery.admissionSequence ?? 0,
      commandKey: row.id,
      taskKey: row.taskKey,
      receiverRevision: delivery.receiverRevision,
      mapping: delivery.work.mapping,
      fact: delivery.work.fact,
      mergeIntent: delivery.work.recordLink === true && delivery.work.mergeIntent === true,
    };
  }
  // #endregion
}
