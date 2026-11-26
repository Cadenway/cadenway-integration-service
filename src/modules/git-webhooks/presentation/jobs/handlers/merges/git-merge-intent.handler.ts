import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import type { SubmitGitMergeIntent } from '../../../../application/use-cases/commands/merges/submit-git-merge-intent/submit-git-merge-intent.use-case.js';

const jobPayload = z.strictObject({ linkId: z.uuidv7() });
const organizationIdSchema = z.uuidv7();

/**
 * Runs one attempt of a link's merge intent; the use case schedules the next one itself. An
 * intent left pending past Task's receipt window is reported by the hourly maintenance.
 */
export class GitMergeIntentJobHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports rejected jobs without payload fields. */
  private readonly logger = new Logger(GitMergeIntentJobHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the queue to the merge intent command. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly command: Pick<SubmitGitMergeIntent, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the merge intent worker on this replica. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.workers.work(this.queue, (job) => this.handle(job));
  }

  /** Submits the attempt; an unexpected failure goes through the queue's bounded retries. */
  public async handle(job: Job): Promise<void> {
    job.signal.throwIfAborted();
    const organization = organizationIdSchema.safeParse(job.organizationId);
    const payload = jobPayload.safeParse(job.payload);
    if (!organization.success || !payload.success) {
      this.logger.error({ jobId: job.id, reason: 'invalid-job' }, 'Rejected Git merge intent job');
      return;
    }
    try {
      await this.command.execute({
        organizationId: organization.data,
        linkId: payload.data.linkId,
      });
    } catch {
      // The jobs runtime stores the failure. Exclude exception text, causes and payloads.
      throw new Error('Git merge intent attempt did not complete.');
    }
  }
  // #endregion
}
