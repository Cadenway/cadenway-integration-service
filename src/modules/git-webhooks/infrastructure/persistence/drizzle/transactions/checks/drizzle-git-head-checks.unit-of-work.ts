import { createHash } from 'node:crypto';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { GitHeadChecksPage } from '../../../../../application/models/checks/git-head-checks-page.model.js';
import type { GitHeadChecksUnitOfWork } from '../../../../../application/ports/outbound/transactions/checks/git-head-checks-unit-of-work.port.js';
import type { GitHeadChecksJobsProducer } from '../../../../jobs/pg-boss/checks/git-head-checks.adapter.js';
import type { GitDispatchJobsProducer } from '../../../../jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import type { DrizzleGitLinkRepository } from '../../repositories/links/drizzle-git-link.repository.js';
import { gitWebhookReceivers } from '../../schemas/deliveries/git-webhook-receivers.schema.js';
import { DrizzleGitDeliveryTransaction } from '../deliveries/drizzle-git-delivery.unit-of-work.js';

/**
 * Records one head refresh page as a receipt of its own, in the order of admission, under the
 * receiver lock that admission takes, with the receiver's current revision and mapping.
 */
export class DrizzleGitHeadChecksUnitOfWork implements GitHeadChecksUnitOfWork {
  // #region Constructor
  /** Uses the tenant runner, the link store and the dispatch and page job producers. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly links: Pick<DrizzleGitLinkRepository, 'findHeadTargetsPage'>,
    private readonly dispatch: Pick<GitDispatchJobsProducer, 'enqueue'>,
    private readonly pages: Pick<GitHeadChecksJobsProducer, 'enqueue'>,
  ) {}
  // #endregion

  // #region Methods
  /** Admits the page and queues the next one in the same transaction. */
  public refresh(
    page: GitHeadChecksPage,
    limit: number,
  ): ReturnType<GitHeadChecksUnitOfWork['refresh']> {
    return runWithOrganizationContext(
      {
        organizationId: page.organizationId,
        actor: { type: 'system', id: 'integration-service' },
        role: null,
        scopes: [],
      },
      () =>
        this.runner.run(async (scope) => {
          const stopped = { status: 'stopped', links: 0, more: false } as const;
          const receivers = await scope.db
            .select({ revision: gitWebhookReceivers.revision })
            .from(gitWebhookReceivers)
            .where(
              and(
                eq(gitWebhookReceivers.organizationId, page.organizationId),
                eq(gitWebhookReceivers.id, page.receiverId),
                eq(gitWebhookReceivers.provider, page.binding.provider),
                eq(gitWebhookReceivers.enabled, true),
              ),
            )
            .limit(1)
            .for('update');
          const receiver = receivers[0];
          if (receiver === undefined) return stopped;
          const transaction = new DrizzleGitDeliveryTransaction(
            scope,
            page.organizationId,
            page.receiverId,
            page.binding.provider,
            receiver.revision,
            this.dispatch,
          );
          const mapping = await transaction.findMapping(page.binding);
          if (mapping === null) return stopped;
          const { targets, more } = await this.links.findHeadTargetsPage(scope, {
            organizationId: page.organizationId,
            receiverId: page.receiverId,
            binding: page.binding,
            headSha: page.headSha,
            excludeRequestNumber: page.excludeRequestNumber,
            after: page.after,
            limit,
          });
          if (targets.length !== 0) {
            await transaction.admitRefresh({
              digest: createHash('sha256')
                .update(`head-checks:${page.source}:${String(page.page)}`)
                .digest('hex'),
              work: {
                mapping,
                fact: {
                  kind: 'actionable',
                  trigger: 'head_checks',
                  headSha: page.headSha,
                  targets: targets.map(({ taskKey, requestNumber }) => ({
                    taskKey,
                    requestNumber,
                  })),
                  checks: {
                    headSha: page.headSha,
                    attemptId: page.attemptId,
                    completedAtMs: page.observedAtMs,
                    observed: true,
                  },
                  taskKeys: [...new Set(targets.map(({ taskKey }) => taskKey))],
                  closingTaskKeys: [],
                },
              },
            });
          }
          const last = targets.at(-1);
          if (more && last !== undefined) {
            await this.pages.enqueue(scope, {
              ...page,
              page: page.page + 1,
              after: { taskKey: last.taskKey, linkId: last.linkId },
            });
          }
          return { status: 'refreshed', links: targets.length, more } as const;
        }),
    );
  }
  // #endregion
}
