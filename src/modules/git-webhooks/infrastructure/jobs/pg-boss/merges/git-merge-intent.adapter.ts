import { JobProducer, type JobsTransaction } from '@cadenway/nest-jobs/runtime';
import { Inject, Injectable } from '@nestjs/common';

import { GIT_MERGE_INTENT_QUEUE } from '../../../../../../config/job-queues.js';

/** Records one job per merge intent attempt in the transaction that creates or retries it. */
@Injectable()
export class GitMergeIntentJobsProducer {
  // #region Constructor
  /** Uses the kit's transaction-bound producer. */
  public constructor(@Inject(JobProducer) private readonly producer: JobProducer) {}
  // #endregion

  // #region Methods
  /**
   * Enqueues attempt `attempt` of the link's intent once, optionally from `startAfter`. A
   * recovery has an occurrence of its own, since the exhausted job of the attempt is retained.
   * Returns whether a runnable job was inserted.
   */
  public async enqueue(
    scope: JobsTransaction,
    linkId: string,
    attempt: number,
    startAfter?: Date,
    recovery?: number,
  ): Promise<boolean> {
    if (scope.organizationId === null) {
      throw new Error('A merge intent job requires a tenant transaction.');
    }
    const occurrence = `${linkId}:${String(attempt)}`;
    const result = await this.producer.enqueue(
      scope,
      GIT_MERGE_INTENT_QUEUE.name,
      { linkId },
      {
        occurrenceKey:
          recovery === undefined ? occurrence : `${occurrence}:recovery:${String(recovery)}`,
        ...(startAfter === undefined ? {} : { startAfter }),
      },
    );
    return !result.duplicate;
  }
  // #endregion
}
