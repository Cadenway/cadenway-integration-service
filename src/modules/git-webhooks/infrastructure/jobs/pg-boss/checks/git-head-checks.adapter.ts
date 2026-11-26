import { JobProducer, type JobsTransaction } from '@cadenway/nest-jobs/runtime';
import { Inject, Injectable } from '@nestjs/common';

import { GIT_HEAD_CHECKS_QUEUE } from '../../../../../../config/job-queues.js';
import type { GitHeadChecksPage } from '../../../../application/models/checks/git-head-checks-page.model.js';

/** Records one job per page of a head refresh, in the transaction that admits its delivery. */
@Injectable()
export class GitHeadChecksJobsProducer {
  // #region Constructor
  /** Uses the kit's transaction-bound producer. */
  public constructor(@Inject(JobProducer) private readonly producer: JobProducer) {}
  // #endregion

  // #region Methods
  /** Enqueues the page once per check delivery and page number. */
  public async enqueue(scope: JobsTransaction, page: GitHeadChecksPage): Promise<void> {
    if (scope.organizationId !== page.organizationId) {
      throw new Error('A head refresh job requires its tenant transaction.');
    }
    // The tenant travels in the job envelope, not in its payload.
    const payload = {
      receiverId: page.receiverId,
      binding: page.binding,
      headSha: page.headSha,
      attemptId: page.attemptId,
      observedAtMs: page.observedAtMs,
      source: page.source,
      page: page.page,
      excludeRequestNumber: page.excludeRequestNumber,
      after: page.after,
    };
    await this.producer.enqueue(scope, GIT_HEAD_CHECKS_QUEUE.name, payload, {
      occurrenceKey: `${page.source}:${String(page.page)}`,
    });
  }
  // #endregion
}
