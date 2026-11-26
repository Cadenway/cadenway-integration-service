import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { RunGitLinkMaintenance } from '../../../../application/use-cases/commands/maintenance/run-git-link-maintenance/run-git-link-maintenance.use-case.js';

/** Every hour, at minute 17, in UTC. */
const schedule = '17 * * * *';

/**
 * Schedules and runs the hourly Git link maintenance. It reports each link still marked
 * `reconciliation pending` and each merge intent left unconfirmed, for operator follow-up:
 * Integration has no provider client to resolve them before gap B5.
 */
export class GitLinkMaintenanceJobHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports link identifiers and counts only. */
  private readonly logger = new Logger(GitLinkMaintenanceJobHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the queue, its schedule and the maintenance command. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly scheduler: Pick<JobScheduler, 'schedule'>,
    private readonly command: Pick<RunGitLinkMaintenance, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Registers the idempotent schedule and starts the worker on this replica. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.schedule(this.queue, schedule, { timeZone: 'UTC', key: 'hourly' });
    await this.workers.work(this.queue, (job) => this.handle(job));
  }

  /** Runs one pass and logs what needs follow-up. */
  public async handle(job: Job): Promise<void> {
    job.signal.throwIfAborted();
    let report: Awaited<ReturnType<RunGitLinkMaintenance['execute']>>;
    try {
      report = await this.command.execute({ signal: job.signal });
    } catch {
      throw new Error('Git link maintenance did not complete.');
    }
    for (const link of report.reconciliationPending) {
      this.logger.warn(
        { ...link, reason: 'git-link-reconciliation-pending' },
        'Git link lifecycle awaits reconciliation',
      );
    }
    for (const link of report.unconfirmedMergeIntents) {
      this.logger.warn(
        { ...link, reason: 'git-merge-intent-unconfirmed' },
        'Git merge intent stays pending past the Task receipt window',
      );
    }
    this.logger.log(
      {
        prunedObservations: report.prunedObservations,
        reconciliationPending: report.reconciliationPending.length,
        unconfirmedMergeIntents: report.unconfirmedMergeIntents.length,
      },
      'Git link maintenance completed',
    );
  }
  // #endregion
}
