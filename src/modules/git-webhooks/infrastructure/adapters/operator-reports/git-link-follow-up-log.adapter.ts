import { Logger } from '@nestjs/common';

import type { GitLinkFollowUp } from '../../../application/models/maintenance/git-link-follow-up.model.js';
import type { GitLinkFollowUpReporter } from '../../../application/ports/outbound/reports/maintenance/git-link-follow-up-reporter.port.js';

const messages = {
  'reconciliation-pending': 'Git link lifecycle awaits reconciliation',
  'unconfirmed-merge-intent': 'Git merge intent stays pending past the Task receipt window',
} as const;

/** Reports follow-ups as one warning line each, with link identifiers only. */
export class GitLinkFollowUpLogAdapter implements GitLinkFollowUpReporter {
  // #region Properties
  /** Writes through the service's structured logger. */
  private readonly logger = new Logger('GitLinkMaintenance');
  // #endregion

  // #region Methods
  /** Writes each follow-up before the caller marks it reported. */
  public report(
    kind: 'reconciliation-pending' | 'unconfirmed-merge-intent',
    followUps: readonly GitLinkFollowUp[],
  ): Promise<void> {
    for (const followUp of followUps) {
      this.logger.warn({ ...followUp, reason: `git-${kind}` }, messages[kind]);
    }
    return Promise.resolve();
  }
  // #endregion
}
