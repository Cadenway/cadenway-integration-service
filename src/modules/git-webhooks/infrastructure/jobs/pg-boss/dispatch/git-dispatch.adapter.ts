import { JobProducer, type JobsTransaction } from '@cadenway/nest-jobs/runtime';
import { Inject, Injectable } from '@nestjs/common';

import { GIT_DISPATCH_QUEUE } from '../../../../../../config/job-queues.js';

/** Records one job per authenticated receipt and task in the receipt's PostgreSQL transaction. */
@Injectable()
export class GitDispatchJobsProducer {
  // #region Constructor
  /** Uses the kit's transaction-bound producer. */
  public constructor(@Inject(JobProducer) private readonly producer: JobProducer) {}
  // #endregion

  // #region Methods
  /** The job inherits the scope's tenant and contains only the two dispatch identifiers. */
  public async enqueue(scope: JobsTransaction, receiptId: string, taskKey: string): Promise<void> {
    if (scope.organizationId === null)
      throw new Error('Git dispatch requires a tenant transaction.');

    await this.producer.enqueue(
      scope,
      GIT_DISPATCH_QUEUE.name,
      { deliveryId: receiptId, taskKey },
      { occurrenceKey: `${receiptId}:${taskKey}` },
    );
  }
  // #endregion
}
