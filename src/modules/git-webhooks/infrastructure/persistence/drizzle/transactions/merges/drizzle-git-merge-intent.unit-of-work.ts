import { runWithOrganizationContext } from '@cadenway/nest-common';
import type {
  DatabaseSchema,
  TenantTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { GitMergeIntentUnitOfWork } from '../../../../../application/ports/outbound/transactions/merges/git-merge-intent-unit-of-work.port.js';
import {
  decideGitMergeIntentRetry,
  gitMergeIntentWindowMs,
} from '../../../../../domain/policies/merges/decide-git-merge-intent-retry.policy.js';
import type { GitMergeIntentJobsProducer } from '../../../../jobs/pg-boss/merges/git-merge-intent.adapter.js';
import { gitRepositoryMappings } from '../../schemas/deliveries/git-repository-mappings.schema.js';
import { gitWebhookReceivers } from '../../schemas/deliveries/git-webhook-receivers.schema.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitMergeIntents } from '../../schemas/merges/git-merge-intents.schema.js';

type Intent = typeof gitMergeIntents.$inferSelect;

/** Claims and settles merge intent attempts in short tenant transactions on the intent row. */
export class DrizzleGitMergeIntentUnitOfWork implements GitMergeIntentUnitOfWork {
  // #region Constructor
  /** Uses the service's tenant transaction runner and the intent's job producer. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly jobs: Pick<GitMergeIntentJobsProducer, 'enqueue'>,
  ) {}
  // #endregion

  // #region Methods
  /** Claims the next attempt while the intent is pending and inside Task's receipt window. */
  public prepare(
    input: Parameters<GitMergeIntentUnitOfWork['prepare']>[0],
  ): ReturnType<GitMergeIntentUnitOfWork['prepare']> {
    return this.inTenant(input.organizationId, async (scope) => {
      const intent = await this.lock(scope, input.organizationId, input.linkId);
      if (intent?.status !== 'pending' || intent.targetStatus !== 'done') {
        return { status: 'settled' } as const;
      }
      const now = await clock(scope);
      if (now >= intent.windowStartedAt.getTime() + gitMergeIntentWindowMs) {
        return { status: 'expired' } as const;
      }
      const attempt = intent.attempts + 1;
      await scope.db
        .update(gitMergeIntents)
        .set({ attempts: attempt, updatedAt: sql`now()` })
        .where(byLink(input.organizationId, input.linkId));
      if (!(await this.authorityEnabled(scope, intent))) {
        return { status: 'unavailable', attempt } as const;
      }
      return {
        status: 'ready',
        command: {
          organizationId: intent.organizationId,
          linkId: intent.linkId,
          attempt,
          commandKey: intent.commandKey,
          taskKey: intent.taskKey,
          mapping: intent.mapping,
          status: 'done',
        },
      } as const;
    });
  }

  /** Records the answer of the claimed attempt, or schedules the next one with backoff. */
  public settle(
    input: Parameters<GitMergeIntentUnitOfWork['settle']>[0],
  ): ReturnType<GitMergeIntentUnitOfWork['settle']> {
    return this.inTenant(input.organizationId, async (scope) => {
      const intent = await this.lock(scope, input.organizationId, input.linkId);
      if (intent?.status !== 'pending' || intent.attempts !== input.attempt) return 'superseded';
      const { outcome } = input;
      if (outcome.kind !== 'failed') {
        await scope.db
          .update(gitMergeIntents)
          .set({
            status: 'handled',
            disposition: outcome.kind === 'confirmed' ? outcome.disposition : null,
            reason: outcome.kind === 'refused' ? outcome.reason : null,
            updatedAt: sql`now()`,
          })
          .where(byLink(input.organizationId, input.linkId));
        return 'handled';
      }
      const decision = decideGitMergeIntentRetry(
        intent.windowStartedAt.getTime(),
        input.attempt,
        await clock(scope),
      );
      if (decision.status === 'expired') return 'expired';
      await this.jobs.enqueue(
        scope,
        input.linkId,
        input.attempt + 1,
        new Date(decision.startAfterMs),
      );
      return 'retrying';
    });
  }

  /** Locks the intent row, which serializes every attempt for the link. */
  private async lock(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    linkId: string,
  ): Promise<Intent | null> {
    const rows = await scope.db
      .select()
      .from(gitMergeIntents)
      .where(byLink(organizationId, linkId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** Checks that the link's receiver and the recorded mapping are still enabled. */
  private async authorityEnabled(
    scope: TransactionScope<DatabaseSchema>,
    intent: Intent,
  ): Promise<boolean> {
    const { binding, integrationId, spaceId, mappingAuthorUserId } = intent.mapping;
    const conditions = [
      eq(gitLinks.organizationId, intent.organizationId),
      eq(gitLinks.id, intent.linkId),
      eq(gitWebhookReceivers.enabled, true),
      eq(gitRepositoryMappings.provider, binding.provider),
      eq(gitRepositoryMappings.repositoryId, binding.repositoryId),
      eq(gitRepositoryMappings.integrationId, integrationId),
      eq(gitRepositoryMappings.spaceId, spaceId),
      eq(gitRepositoryMappings.mappingAuthorUserId, mappingAuthorUserId),
      eq(gitRepositoryMappings.enabled, true),
    ];
    if (binding.provider === 'github') {
      conditions.push(eq(gitRepositoryMappings.installationId, binding.installationId));
    }
    const rows = await scope.db
      .select({ id: gitRepositoryMappings.id })
      .from(gitLinks)
      .innerJoin(
        gitWebhookReceivers,
        and(
          eq(gitWebhookReceivers.organizationId, gitLinks.organizationId),
          eq(gitWebhookReceivers.id, gitLinks.receiverId),
        ),
      )
      .innerJoin(
        gitRepositoryMappings,
        and(
          eq(gitRepositoryMappings.organizationId, gitLinks.organizationId),
          eq(gitRepositoryMappings.receiverId, gitLinks.receiverId),
        ),
      )
      .where(and(...conditions))
      .limit(1);
    return rows.length !== 0;
  }

  /** Runs with the tenant recorded with the job, never one supplied by a provider. */
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
  // #endregion
}

function byLink(organizationId: string, linkId: string): ReturnType<typeof and> {
  return and(
    eq(gitMergeIntents.organizationId, organizationId),
    eq(gitMergeIntents.linkId, linkId),
  );
}

/** Reads the PostgreSQL clock that also stamped the intent. */
async function clock(scope: TransactionScope<DatabaseSchema>): Promise<number> {
  const result = await scope.db.execute<{ readonly now: number }>(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::double precision as now`,
  );
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error('The database clock is unavailable.');
  return now;
}
