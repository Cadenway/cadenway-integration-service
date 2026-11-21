import { taskPurgedV1Schema } from '@cadenway/contracts/events/integration-service';
import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import type { PurgeTaskGitLinks } from '../../../../application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';

const jobPayload = z.strictObject({
  eventId: taskPurgedV1Schema.shape.id,
  taskKey: taskPurgedV1Schema.shape.key,
  batch: z.int().positive(),
});

/** Resumes a previously admitted terminal Task purge. */
export class GitPurgeJobHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the worker registry to the same batch command as the initial broker delivery. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly command: Pick<PurgeTaskGitLinks, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the purge worker on this replica. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.workers.work(this.queue, (job) => this.handle(job));
  }

  /** Uses the tenant from the queue envelope and retains only fixed failure diagnostics. */
  public async handle(job: Job): Promise<void> {
    job.signal.throwIfAborted();
    const organization = taskPurgedV1Schema.shape.organizationId.safeParse(job.organizationId);
    const payload = jobPayload.safeParse(job.payload);
    if (!organization.success || !payload.success) {
      throw new Error('Git purge continuation has an invalid envelope.');
    }
    const { eventId, taskKey, batch } = payload.data;
    try {
      await this.command.execute({
        organizationId: organization.data,
        eventId: eventId.toLowerCase(),
        taskKey,
        batch,
        signal: job.signal,
      });
    } catch {
      throw new Error('Git purge batch did not complete.');
    }
  }
  // #endregion
}
