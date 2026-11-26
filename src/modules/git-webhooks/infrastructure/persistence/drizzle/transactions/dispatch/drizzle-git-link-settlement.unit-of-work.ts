import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import type { GitDispatchClaim } from '../../../../../application/models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskActionResult } from '../../../../../application/models/dispatch/git-task-action-result.model.js';
import { gitLinkIdentity } from '../../../../../domain/policies/links/git-link-change.policy.js';
import type { GitMergeIntentJobsProducer } from '../../../../jobs/pg-boss/merges/git-merge-intent.adapter.js';
import type { GitLinkChangedOutbox } from '../../../../messaging/outbox/links/git-link-changed-outbox.adapter.js';
import type { DrizzleGitLinkRepository } from '../../repositories/links/drizzle-git-link.repository.js';
import type { DrizzleGitMergeIntentRepository } from '../../repositories/merges/drizzle-git-merge-intent.repository.js';

/**
 * Settles an authorized dispatch on its link in the dispatch transaction: the link change, one
 * outbox fact per committed version and, for the first verified merge of the link, its merge
 * intent and first submission job ("Merge intent", Integration AsyncAPI).
 */
export class DrizzleGitLinkSettlement {
  // #region Constructor
  /** Binds the link store, its outbox and the merge intent store and jobs. */
  public constructor(
    private readonly links: DrizzleGitLinkRepository,
    private readonly outbox: Pick<GitLinkChangedOutbox, 'append'>,
    private readonly intents: Pick<DrizzleGitMergeIntentRepository, 'recordFirst'>,
    private readonly jobs: Pick<GitMergeIntentJobsProducer, 'enqueue'>,
  ) {}
  // #endregion

  // #region Methods
  /** Records the change under the link lock; the merge intent takes the claim's command key. */
  public async record(
    scope: TransactionScope<DatabaseSchema>,
    claim: GitDispatchClaim,
    receiverId: string,
    placement: Exclude<GitTaskActionResult, { readonly disposition: 'unavailable' }>,
  ): Promise<void> {
    const identity = gitLinkIdentity(
      {
        organizationId: claim.organizationId,
        receiverId,
        binding: claim.mapping.binding,
        taskId: placement.taskId,
      },
      claim.fact,
    );
    const link = await this.links.record(scope, identity, claim.fact, claim.taskKey);
    if (link === null) return;
    for (const event of link.events) {
      await this.outbox.append(scope, {
        organizationId: claim.organizationId,
        integrationId: claim.mapping.integrationId,
        taskKey: claim.taskKey,
        gitLinkId: link.id,
        event,
        placement,
      });
    }
    if (claim.fact.trigger !== 'pr_merged') return;
    const intent = await this.intents.recordFirst(scope, {
      organizationId: claim.organizationId,
      linkId: link.id,
      deliveryId: claim.deliveryId,
      commandKey: claim.commandKey,
      taskKey: claim.taskKey,
      mapping: claim.mapping,
      targetStatus: claim.fact.closingTaskKeys.includes(claim.taskKey) ? 'done' : null,
    });
    if (intent === 'pending') await this.jobs.enqueue(scope, link.id, 1);
  }
  // #endregion
}
