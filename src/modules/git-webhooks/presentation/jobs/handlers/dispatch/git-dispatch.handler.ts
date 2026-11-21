import { ApplyGitTaskStatusActionInternalParams } from '@cadenway/contracts/validators/internal/task-service';
import { ProblemException } from '@cadenway/nest-common';
import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import type { DispatchGitDelivery } from '../../../../application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';

const jobPayload = z.strictObject({
  deliveryId: z.uuidv7(),
  taskKey: ApplyGitTaskStatusActionInternalParams.shape.taskKey,
});
const organizationIdSchema = z.uuidv7();
const receiptWindowMs = 60 * 60 * 1_000;
const clockSkewMs = 60 * 1_000;

/** Executes each admitted target through its durable, idempotent dispatch. */
export class GitDispatchJobHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports rejected jobs without payload fields or provider error details. */
  private readonly logger = new Logger(GitDispatchJobHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the queue to the admitted delivery command. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly dispatch: Pick<DispatchGitDelivery, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the Git worker on this replica. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.workers.work(this.queue, (job) => this.handle(job));
  }

  /** Resolves terminal dispatch decisions and sends unsuccessful attempts through the retry policy. */
  public async handle(job: Job): Promise<void> {
    job.signal.throwIfAborted();
    const organization = organizationIdSchema.safeParse(job.organizationId);
    const payload = jobPayload.safeParse(job.payload);
    if (!organization.success || !payload.success) {
      this.logger.error({ jobId: job.id, reason: 'invalid-job' }, 'Rejected Git dispatch job');
      return;
    }

    const { deliveryId, taskKey } = payload.data;
    // The UUIDv7 embeds the PostgreSQL receipt time, which survives worker restarts and retries.
    const receiptTime = Number.parseInt(deliveryId.slice(0, 8) + deliveryId.slice(9, 13), 16);
    const age = Date.now() - receiptTime;
    if (age >= receiptWindowMs || age < -clockSkewMs) {
      throw new Error('Git dispatch receipt is outside the dispatch window.');
    }

    let failure: string;
    try {
      await this.dispatch.execute({ organizationId: organization.data, deliveryId, taskKey });
      return;
    } catch (error) {
      // The jobs runtime logs and stores the failure. Exclude exception text, causes and payloads.
      failure =
        error instanceof ProblemException
          ? `Git dispatch did not complete (status ${String(error.getStatus())}).`
          : 'Git dispatch did not complete.';
    }
    throw new Error(failure);
  }
  // #endregion
}
