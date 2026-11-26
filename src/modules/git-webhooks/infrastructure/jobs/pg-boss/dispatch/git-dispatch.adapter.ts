import { JobProducer, type JobsTransaction } from '@cadenway/nest-jobs/runtime';
import { Inject, Injectable } from '@nestjs/common';

import {
  GIT_DISPATCH_QUEUE,
  GIT_LINK_DISPATCH_QUEUE,
  GIT_LINK_DISPATCH_V2_QUEUE,
} from '../../../../../../config/job-queues.js';

/**
 * Records one job per authenticated receipt and task in the receipt's PostgreSQL transaction.
 * A receipt goes to the queue its format needs: status-only receipts to the status queue,
 * link receipts of the previous format to the link queue, which previous workers still drain,
 * and receipts recording merge intents and the newer request and check facts to the versioned
 * link queue only current workers consume.
 */
@Injectable()
export class GitDispatchJobsProducer {
  // #region Constructor
  /** Uses the kit's transaction-bound producer. */
  public constructor(@Inject(JobProducer) private readonly producer: JobProducer) {}
  // #endregion

  // #region Methods
  /** Enqueues a target or a deduplicated continuation at the given polling slot. */
  public async enqueue(
    scope: JobsTransaction,
    receiptId: string,
    taskKey: string,
    format: { readonly recordLink?: true; readonly mergeIntent?: true } | null,
    startAfter?: Date,
  ): Promise<void> {
    if (scope.organizationId === null)
      throw new Error('Git dispatch requires a tenant transaction.');

    const queue =
      format?.recordLink !== true
        ? GIT_DISPATCH_QUEUE.name
        : format.mergeIntent === true
          ? GIT_LINK_DISPATCH_V2_QUEUE.name
          : GIT_LINK_DISPATCH_QUEUE.name;
    const occurrenceKey = `${receiptId}:${taskKey}`;
    await this.producer.enqueue(
      scope,
      queue,
      { deliveryId: receiptId, taskKey },
      startAfter === undefined
        ? { occurrenceKey }
        : { occurrenceKey: `${occurrenceKey}:deferred:${startAfter.toISOString()}`, startAfter },
    );
  }
  // #endregion
}
