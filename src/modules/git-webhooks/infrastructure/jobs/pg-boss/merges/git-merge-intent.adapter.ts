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
  /** Enqueues attempt `attempt` of the link's intent once, optionally from `startAfter`. */
  public async enqueue(
    scope: JobsTransaction,
    linkId: string,
    attempt: number,
    startAfter?: Date,
  ): Promise<void> {
    if (scope.organizationId === null) {
      throw new Error('A merge intent job requires a tenant transaction.');
    }
    await this.producer.enqueue(
      scope,
      GIT_MERGE_INTENT_QUEUE.name,
      { linkId },
      {
        occurrenceKey: `${linkId}:${String(attempt)}`,
        ...(startAfter === undefined ? {} : { startAfter }),
      },
    );
  }
  // #endregion
}
