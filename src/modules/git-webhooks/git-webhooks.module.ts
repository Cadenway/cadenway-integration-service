import { CONFIG, InternalHttpClient, InternalTokenSigner } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { JobProducer, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { EventConsumers } from '@cadenway/nest-messaging';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { GIT_DISPATCH_QUEUE, GIT_PURGE_QUEUE } from '../../config/job-queues.js';
import type { GitTaskAction } from './application/ports/outbound/actions/dispatch/git-task-action.port.js';
import { AdmitGitWebhook } from './application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.use-case.js';
import { DispatchGitDelivery } from './application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';
import { PurgeTaskGitLinks } from './application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';
import { gitLinkIdentity } from './domain/policies/links/git-link-change.policy.js';
import { GitLinkChangedOutbox } from './infrastructure/messaging/outbox/links/git-link-changed-outbox.adapter.js';
import { DrizzleGitLinkRepository } from './infrastructure/persistence/drizzle/repositories/links/drizzle-git-link.repository.js';
import { DrizzleGitDispatchUnitOfWork } from './infrastructure/persistence/drizzle/transactions/dispatch/drizzle-git-dispatch.unit-of-work.js';
import { DrizzleGitAdmissionUnitOfWork } from './infrastructure/persistence/drizzle/transactions/deliveries/drizzle-git-admission.unit-of-work.js';
import { DrizzleGitPurgeUnitOfWork } from './infrastructure/persistence/drizzle/transactions/purge/drizzle-git-purge.unit-of-work.js';
import { GitDispatchJobsProducer } from './infrastructure/jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import {
  verifyGitHubWebhook,
  verifyGitLabWebhook,
} from './infrastructure/adapters/provider-signatures/git-webhook-signature.adapter.js';
import { GitTaskHttpAdapter } from './infrastructure/adapters/task-service/git-task-http.adapter.js';
import { GitWebhooksController } from './presentation/http/controllers/deliveries/git-webhooks.controller.js';
import { GitDispatchJobHandler } from './presentation/jobs/handlers/dispatch/git-dispatch.handler.js';
import { GitPurgeJobHandler } from './presentation/jobs/handlers/purge/git-purge.handler.js';
import { TaskPurgedHandler } from './presentation/messaging/handlers/purge/task-purged.handler.js';

async function createTaskAction(config: AppConfig): Promise<GitTaskAction> {
  const privateJwk = config.INTERNAL_TOKEN_PRIVATE_JWK;
  const baseUrl = config.TASK_SERVICE_URL;
  if (privateJwk === undefined || baseUrl === undefined) {
    return {
      apply: () => Promise.reject(new Error('The Task action transport is not configured.')),
    };
  }
  const signer = await InternalTokenSigner.create({
    issuer: config.INTERNAL_TOKEN_ISSUER,
    privateJwk,
  });
  return new GitTaskHttpAdapter(
    new InternalHttpClient({
      service: 'task-service',
      baseUrl,
      signer,
      allowedUnavailableProblemCodes: ['task.action-unavailable'],
    }),
  );
}

/** Composition root for inbound Git provider webhooks. */
@Module({
  controllers: [GitWebhooksController],
  providers: [
    GitDispatchJobsProducer,
    {
      provide: AdmitGitWebhook,
      inject: [TenantTransactionRunner, CONFIG, GitDispatchJobsProducer],
      useFactory: (
        runner: TenantTransactionRunner<DatabaseSchema>,
        config: AppConfig,
        jobs: GitDispatchJobsProducer,
      ) =>
        new AdmitGitWebhook(
          new DrizzleGitAdmissionUnitOfWork(runner, config.GIT_WEBHOOK_RECEIVERS, jobs),
          {
            verify: (delivery, secret) =>
              delivery.provider === 'github'
                ? verifyGitHubWebhook(delivery.rawBody, delivery.signature, secret)
                : verifyGitLabWebhook({
                    rawBody: delivery.rawBody,
                    deliveryId: delivery.deliveryId,
                    timestamp: delivery.timestamp,
                    signature: delivery.signature,
                    signingToken: secret,
                    currentUnixSeconds: delivery.currentUnixSeconds,
                  }),
          },
        ),
    },
    {
      provide: DispatchGitDelivery,
      inject: [TenantTransactionRunner, CONFIG, OutboxWriter],
      useFactory: async (
        runner: TenantTransactionRunner<DatabaseSchema>,
        config: AppConfig,
        outboxWriter: OutboxWriter,
      ) => {
        const links = new DrizzleGitLinkRepository();
        const outbox = new GitLinkChangedOutbox(outboxWriter);
        const work = new DrizzleGitDispatchUnitOfWork(
          runner,
          config.GIT_LINK_EVENTS_ENABLED
            ? async (scope, claim, receiverId, placement) => {
                const identity = gitLinkIdentity(
                  {
                    organizationId: claim.organizationId,
                    receiverId,
                    binding: claim.mapping.binding,
                    taskId: placement.taskId,
                  },
                  claim.fact,
                );
                const link = await links.record(scope, identity, claim.fact, claim.taskKey);
                if (link === null) return;
                await outbox.append(scope, {
                  organizationId: claim.organizationId,
                  integrationId: claim.mapping.integrationId,
                  taskKey: claim.taskKey,
                  gitLinkId: link.id,
                  event: link.event,
                  placement,
                });
              }
            : undefined,
        );
        return new DispatchGitDelivery(work, await createTaskAction(config));
      },
    },
    {
      provide: GitDispatchJobHandler,
      inject: [JobWorkerRegistry, DispatchGitDelivery],
      useFactory: (workers: JobWorkerRegistry, dispatch: DispatchGitDelivery) =>
        new GitDispatchJobHandler(workers, dispatch, GIT_DISPATCH_QUEUE.name),
    },
    {
      provide: PurgeTaskGitLinks,
      inject: [TenantTransactionRunner, JobProducer],
      useFactory: (runner: TenantTransactionRunner<DatabaseSchema>, producer: JobProducer) =>
        new PurgeTaskGitLinks(
          new DrizzleGitPurgeUnitOfWork(runner, new DrizzleGitLinkRepository(), producer),
        ),
    },
    {
      provide: TaskPurgedHandler,
      inject: [CONFIG, EventConsumers, PurgeTaskGitLinks],
      useFactory: (config: AppConfig, consumers: EventConsumers, purge: PurgeTaskGitLinks) =>
        config.GIT_LINK_EVENTS_ENABLED ? new TaskPurgedHandler(consumers, purge) : null,
    },
    {
      provide: GitPurgeJobHandler,
      inject: [CONFIG, JobWorkerRegistry, PurgeTaskGitLinks],
      useFactory: (config: AppConfig, workers: JobWorkerRegistry, purge: PurgeTaskGitLinks) =>
        config.GIT_LINK_EVENTS_ENABLED
          ? new GitPurgeJobHandler(workers, purge, GIT_PURGE_QUEUE.name)
          : null,
    },
  ],
})
export class GitWebhooksModule {}
