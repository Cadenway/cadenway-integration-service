import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import type { RefreshGitHeadChecks } from '../../../../application/use-cases/commands/checks/refresh-git-head-checks/refresh-git-head-checks.use-case.js';

const providerId = z.int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const jobPayload = z.strictObject({
  receiverId: z.uuidv7(),
  binding: z.discriminatedUnion('provider', [
    z.strictObject({
      provider: z.literal('github'),
      repositoryId: providerId,
      installationId: providerId,
    }),
    z.strictObject({ provider: z.literal('gitlab'), repositoryId: providerId }),
  ]),
  headSha: revision,
  attemptId: providerId,
  observedAtMs: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  source: z.string().regex(/^[0-9a-f]{64}$/u),
  page: z.int().nonnegative().max(100_000),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('head') }),
    z.strictObject({
      kind: z.literal('request'),
      requestNumber: providerId,
      requestState: z.strictObject({
        state: z.enum(['open', 'closed', 'merged']),
        observedAtMs: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      }),
    }),
  ]),
  after: z
    .strictObject({
      taskKey: z.string().regex(/^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u),
      linkId: z.uuidv7(),
    })
    .nullable(),
});
const organizationIdSchema = z.uuidv7();

/** Runs one page of a head refresh; the page queues the next one itself. */
export class GitHeadChecksJobHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports rejected jobs without payload fields. */
  private readonly logger = new Logger(GitHeadChecksJobHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the queue to the head refresh command. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly command: Pick<RefreshGitHeadChecks, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the head refresh worker on this replica. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.workers.work(this.queue, (job) => this.handle(job));
  }

  /** Records the page; an unexpected failure goes through the queue's bounded retries. */
  public async handle(job: Job): Promise<void> {
    job.signal.throwIfAborted();
    const organization = organizationIdSchema.safeParse(job.organizationId);
    const payload = jobPayload.safeParse(job.payload);
    if (!organization.success || !payload.success) {
      this.logger.error({ jobId: job.id, reason: 'invalid-job' }, 'Rejected Git head refresh job');
      return;
    }
    try {
      await this.command.execute({ ...payload.data, organizationId: organization.data });
    } catch {
      // The jobs runtime stores the failure. Exclude exception text, causes and payloads.
      throw new Error('Git head refresh page did not complete.');
    }
  }
  // #endregion
}
