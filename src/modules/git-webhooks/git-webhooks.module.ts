import { CONFIG, InternalHttpClient, InternalTokenSigner } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { GIT_DISPATCH_QUEUE } from '../../config/job-queues.js';
import type { GitTaskAction } from './application/ports/outbound/actions/dispatch/git-task-action.port.js';
import { AdmitGitWebhook } from './application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.use-case.js';
import { DispatchGitDelivery } from './application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';
import { DrizzleGitDispatchUnitOfWork } from './infrastructure/persistence/drizzle/transactions/dispatch/drizzle-git-dispatch.unit-of-work.js';
import { DrizzleGitAdmissionUnitOfWork } from './infrastructure/persistence/drizzle/transactions/deliveries/drizzle-git-admission.unit-of-work.js';
import { GitDispatchJobsProducer } from './infrastructure/jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import {
  verifyGitHubWebhook,
  verifyGitLabWebhook,
} from './infrastructure/adapters/provider-signatures/git-webhook-signature.adapter.js';
import { GitTaskHttpAdapter } from './infrastructure/adapters/task-service/git-task-http.adapter.js';
import { GitWebhooksController } from './presentation/http/controllers/deliveries/git-webhooks.controller.js';
import { GitDispatchJobHandler } from './presentation/jobs/handlers/dispatch/git-dispatch.handler.js';

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
      inject: [TenantTransactionRunner, CONFIG],
      useFactory: async (runner: TenantTransactionRunner<DatabaseSchema>, config: AppConfig) =>
        new DispatchGitDelivery(
          new DrizzleGitDispatchUnitOfWork(runner),
          await createTaskAction(config),
        ),
    },
    {
      provide: GitDispatchJobHandler,
      inject: [JobWorkerRegistry, DispatchGitDelivery],
      useFactory: (workers: JobWorkerRegistry, dispatch: DispatchGitDelivery) =>
        new GitDispatchJobHandler(workers, dispatch, GIT_DISPATCH_QUEUE.name),
    },
  ],
})
export class GitWebhooksModule {}
