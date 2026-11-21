import { getOrganizationContext, runWithOrganizationContext } from '@cadenway/nest-common';
import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { JobProducer } from '@cadenway/nest-jobs/runtime';

import { GIT_PURGE_QUEUE } from '../../../../../../../config/job-queues.js';
import type { GitPurgeUnitOfWork } from '../../../../../application/ports/outbound/transactions/purge/git-purge-unit-of-work.port.js';
import type { DrizzleGitLinkRepository } from '../../repositories/links/drizzle-git-link.repository.js';

/** Commits purge progress and its next pg-boss occurrence on the same connection. */
export class DrizzleGitPurgeUnitOfWork implements GitPurgeUnitOfWork {
  // #region Constructor
  /** Uses the same tenant runner as the broker deduplicator. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly links: DrizzleGitLinkRepository,
    private readonly producer: JobProducer,
  ) {}
  // #endregion

  // #region Methods
  /** Preserves a verified broker context or opens a tenant scope for a service-owned job. */
  public async run(
    organizationId: string,
    work: Parameters<GitPurgeUnitOfWork['run']>[1],
  ): Promise<void> {
    const current = getOrganizationContext();
    if (current !== undefined && current.organizationId !== organizationId) {
      throw new Error('Git purge tenant does not match the active context.');
    }
    const run = () =>
      this.runner.run(async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error('Git purge tenant does not match the transaction.');
        }
        await work({
          purge: (taskKey) => this.links.purge(scope, organizationId, taskKey),
          enqueue: async (batch) => {
            await this.producer.enqueue(scope, GIT_PURGE_QUEUE.name, batch, {
              occurrenceKey: `${batch.eventId}:${String(batch.batch)}`,
            });
          },
        });
      });
    if (current !== undefined) return run();

    return runWithOrganizationContext(
      {
        organizationId,
        actor: { type: 'system', id: 'integration-service' },
        role: null,
        scopes: [],
      },
      run,
    );
  }
  // #endregion
}
