import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { GitLinkFollowUp } from '../../../../../application/models/maintenance/git-link-follow-up.model.js';
import type { GitLinkMaintenanceUnitOfWork } from '../../../../../application/ports/outbound/transactions/maintenance/git-link-maintenance-unit-of-work.port.js';
import { gitMergeIntentWindowMs } from '../../../../../domain/policies/merges/decide-git-merge-intent-retry.policy.js';
import { DrizzleGitCheckObservationRepository } from '../../repositories/checks/drizzle-git-check-observation.repository.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitMergeIntents } from '../../schemas/merges/git-merge-intents.schema.js';

/**
 * Runs each maintenance step in its own system transaction. Every statement names the rows it
 * touches explicitly and is bounded, since system access crosses organizations.
 */
export class DrizzleGitLinkMaintenanceUnitOfWork implements GitLinkMaintenanceUnitOfWork {
  // #region Constructor
  /** Uses the service's system transaction runner. */
  public constructor(
    private readonly runner: SystemTransactionRunner<DatabaseSchema>,
    private readonly observations = new DrizzleGitCheckObservationRepository(),
  ) {}
  // #endregion

  // #region Methods
  /** Deletes one batch of expired observations, skipping rows another pass holds. */
  public pruneCheckObservations(limit: number): Promise<number> {
    return this.runner.run((scope) => this.observations.pruneExpired(scope, limit));
  }

  /** Reads the oldest marks first, through the partial index on the mark. */
  public findReconciliationPending(limit: number): Promise<readonly GitLinkFollowUp[]> {
    return this.runner.run(
      async (scope) => {
        const rows = await scope.db
          .select({ organizationId: gitLinks.organizationId, gitLinkId: gitLinks.id })
          .from(gitLinks)
          .where(sql`${gitLinks.reconciliationPendingSince} is not null`)
          .orderBy(gitLinks.reconciliationPendingSince)
          .limit(limit);
        return rows;
      },
      { readOnly: true },
    );
  }

  /** Stamps `reported_at` so each unconfirmed intent is reported once. */
  public reportUnconfirmedMergeIntents(limit: number): Promise<readonly GitLinkFollowUp[]> {
    return this.runner.run(async (scope) => {
      const result = await scope.db.execute<{
        readonly organization_id: string;
        readonly link_id: string;
      }>(sql`
        update ${gitMergeIntents}
           set reported_at = now()
         where (organization_id, link_id) in (
           select organization_id, link_id from ${gitMergeIntents}
            where status = 'pending'
              and reported_at is null
              and created_at < now() - make_interval(secs => ${gitMergeIntentWindowMs / 1_000})
            order by created_at
            limit ${limit}
            for update skip locked
         )
        returning organization_id, link_id`);
      return result.rows.map((row) => ({
        organizationId: row.organization_id,
        gitLinkId: row.link_id,
      }));
    });
  }
  // #endregion
}
