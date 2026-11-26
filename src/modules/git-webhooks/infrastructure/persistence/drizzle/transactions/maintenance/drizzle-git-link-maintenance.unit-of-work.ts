import { runWithOrganizationContext } from '@cadenway/nest-common';
import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TenantTransactionRunner,
} from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { GitLinkFollowUp } from '../../../../../application/models/maintenance/git-link-follow-up.model.js';
import type { GitLinkMaintenanceUnitOfWork } from '../../../../../application/ports/outbound/transactions/maintenance/git-link-maintenance-unit-of-work.port.js';
import { gitMergeIntentWindowMs } from '../../../../../domain/policies/merges/decide-git-merge-intent-retry.policy.js';
import type { GitMergeIntentJobsProducer } from '../../../../jobs/pg-boss/merges/git-merge-intent.adapter.js';
import { DrizzleGitCheckObservationRepository } from '../../repositories/checks/drizzle-git-check-observation.repository.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitMergeIntents } from '../../schemas/merges/git-merge-intents.schema.js';

/** Longer than the longest retry delay, so a pending intent this old has lost its next job. */
const strandedAfter = "interval '2 hours'";

/**
 * Runs each maintenance step in its own system transaction, or in the intent's own tenant
 * transaction to enqueue a job. Every statement names the rows it touches and is bounded,
 * since system access crosses organizations.
 */
export class DrizzleGitLinkMaintenanceUnitOfWork implements GitLinkMaintenanceUnitOfWork {
  // #region Constructor
  /** Uses the service's system and tenant runners and the merge intent job producer. */
  public constructor(
    private readonly runner: SystemTransactionRunner<DatabaseSchema>,
    private readonly tenants: TenantTransactionRunner<DatabaseSchema>,
    private readonly jobs: Pick<GitMergeIntentJobsProducer, 'enqueue'>,
    private readonly observations = new DrizzleGitCheckObservationRepository(),
  ) {}
  // #endregion

  // #region Methods
  /** Deletes one batch of expired observations, skipping rows another pass holds. */
  public pruneCheckObservations(limit: number): Promise<number> {
    return this.runner.run((scope) => this.observations.pruneExpired(scope, limit));
  }

  /** Lists unreported marks, oldest first, through the partial index on the mark. */
  public findReconciliationPending(limit: number): Promise<readonly GitLinkFollowUp[]> {
    return this.runner.run(
      async (scope) => {
        const result = await scope.db.execute<{
          readonly organization_id: string;
          readonly id: string;
        }>(sql`
          select organization_id, id from ${gitLinks}
           where reconciliation_pending_since is not null
             and reconciliation_reported_at is null
             and status <> 'merged'
           order by reconciliation_pending_since
           limit ${limit}`);
        return result.rows.map((row) => ({
          organizationId: row.organization_id,
          gitLinkId: row.id,
        }));
      },
      { readOnly: true },
    );
  }

  /** Stamps `reconciliation_reported_at` on reported marks that are still pending. */
  public markReconciliationReported(followUps: readonly GitLinkFollowUp[]): Promise<void> {
    return this.runner.run(async (scope) => {
      for (const followUp of followUps) {
        await scope.db.execute(sql`
          update ${gitLinks} set reconciliation_reported_at = now()
           where organization_id = ${followUp.organizationId} and id = ${followUp.gitLinkId}
             and reconciliation_pending_since is not null
             and reconciliation_reported_at is null`);
      }
    });
  }

  /** Lists unreported intents left pending past the window, oldest window first. */
  public findUnconfirmedMergeIntents(limit: number): Promise<readonly GitLinkFollowUp[]> {
    return this.runner.run(
      async (scope) => {
        const result = await scope.db.execute<{
          readonly organization_id: string;
          readonly link_id: string;
        }>(sql`
          select organization_id, link_id from ${gitMergeIntents}
           where status = 'pending'
             and reported_at is null
             and window_started_at < now() - make_interval(secs => ${gitMergeIntentWindowMs / 1_000})
           order by window_started_at
           limit ${limit}`);
        return result.rows.map((row) => ({
          organizationId: row.organization_id,
          gitLinkId: row.link_id,
        }));
      },
      { readOnly: true },
    );
  }

  /** Stamps `reported_at` on reported intents that are still pending. */
  public markMergeIntentsReported(followUps: readonly GitLinkFollowUp[]): Promise<void> {
    return this.runner.run(async (scope) => {
      for (const followUp of followUps) {
        await scope.db.execute(sql`
          update ${gitMergeIntents} set reported_at = now()
           where organization_id = ${followUp.organizationId} and link_id = ${followUp.gitLinkId}
             and status = 'pending' and reported_at is null`);
      }
    });
  }

  /**
   * Re-enqueues the next attempt of pending intents untouched for longer than any retry delay
   * while still inside the window, which happens once the queue exhausted its own retries.
   * Each recovery has its own recorded occurrence, counted only once its job is queued.
   */
  public async resumePendingMergeIntents(limit: number): Promise<number> {
    const stranded = await this.runner.run(
      async (scope) =>
        (
          await scope.db.execute<{
            readonly organization_id: string;
            readonly link_id: string;
          }>(
            sql.raw(`
            select organization_id, link_id from git_merge_intents
             where status = 'pending'
               and target_status = 'done'
               and reported_at is null
               and updated_at < now() - ${strandedAfter}
               and window_started_at > now() - make_interval(secs => ${String(gitMergeIntentWindowMs / 1_000)})
             order by updated_at
             limit ${String(limit)}`),
          )
        ).rows,
      { readOnly: true },
    );
    for (const intent of stranded) {
      await runWithOrganizationContext(
        {
          organizationId: intent.organization_id,
          actor: { type: 'system', id: 'integration-service' },
          role: null,
          scopes: [],
        },
        () =>
          this.tenants.run(async (scope) => {
            const byLink = and(
              eq(gitMergeIntents.organizationId, intent.organization_id),
              eq(gitMergeIntents.linkId, intent.link_id),
            );
            const rows = await scope.db
              .select({
                status: gitMergeIntents.status,
                attempts: gitMergeIntents.attempts,
                recoveries: gitMergeIntents.recoveries,
              })
              .from(gitMergeIntents)
              .where(byLink)
              .limit(1)
              .for('update');
            const current = rows[0];
            if (current?.status !== 'pending') return;
            // Same command key: the recovery only replaces the job the queue gave up on.
            const recovery = current.recoveries + 1;
            const queued = await this.jobs.enqueue(
              scope,
              intent.link_id,
              current.attempts + 1,
              undefined,
              recovery,
            );
            await scope.db
              .update(gitMergeIntents)
              .set({ ...(queued ? { recoveries: recovery } : {}), updatedAt: sql`now()` })
              .where(byLink);
          }),
      );
    }
    return stranded.length;
  }
  // #endregion
}
