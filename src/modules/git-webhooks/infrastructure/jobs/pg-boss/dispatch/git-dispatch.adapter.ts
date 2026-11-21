import { JobProducer, type JobsTransaction } from '@cadenway/nest-jobs/runtime';
import { Inject, Injectable } from '@nestjs/common';

import {
  GIT_DISPATCH_QUEUE,
  GIT_LINK_DISPATCH_QUEUE,
} from '../../../../../../config/job-queues.js';

/** Records one job per authenticated receipt and task in the receipt's PostgreSQL transaction. */
@Injectable()
export class GitDispatchJobsProducer {
  // #region Constructor
  /** Uses the kit's transaction-bound producer. */
  public constructor(@Inject(JobProducer) private readonly producer: JobProducer) {}
  // #endregion

  // #region Methods
  /** Sends link-only work to its own queue and preserves the receipt-scoped occurrence key. */
  public async enqueue(
    scope: JobsTransaction,
    receiptId: string,
    taskKey: string,
    linkOnly = false,
  ): Promise<void> {
    if (scope.organizationId === null)
      throw new Error('Git dispatch requires a tenant transaction.');

    await this.producer.enqueue(
      scope,
      linkOnly ? GIT_LINK_DISPATCH_QUEUE.name : GIT_DISPATCH_QUEUE.name,
      { deliveryId: receiptId, taskKey },
      { occurrenceKey: `${receiptId}:${taskKey}` },
    );
  }
  // #endregion
}
