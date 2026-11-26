import { CONFIG, InternalHttpClient, InternalTokenSigner, loadConfig } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  databaseConfigShape,
  type DatabaseSchema,
} from '@cadenway/nest-common/database';
import { JobProducer, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { EventConsumers } from '@cadenway/nest-messaging';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { Module } from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../config/app-config.js';
import {
  GIT_DISPATCH_QUEUE,
  GIT_HEAD_CHECKS_QUEUE,
  GIT_LINK_DISPATCH_QUEUE,
  GIT_LINK_DISPATCH_V2_QUEUE,
  GIT_LINK_MAINTENANCE_QUEUE,
  GIT_MERGE_INTENT_QUEUE,
  GIT_PURGE_QUEUE,
} from '../../config/job-queues.js';
import type { GitTaskAction } from './application/ports/outbound/actions/dispatch/git-task-action.port.js';
import { decideGitCheckPrerequisites } from './application/models/dispatch/git-check-prerequisites.model.js';
import { RefreshGitHeadChecks } from './application/use-cases/commands/checks/refresh-git-head-checks/refresh-git-head-checks.use-case.js';
import { AdmitGitWebhook } from './application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.use-case.js';
import { ManageGitWebhookBinding } from './application/use-cases/commands/bindings/manage-git-webhook-binding/manage-git-webhook-binding.use-case.js';
import { DispatchGitDelivery } from './application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';
import { RunGitLinkMaintenance } from './application/use-cases/commands/maintenance/run-git-link-maintenance/run-git-link-maintenance.use-case.js';
import { SubmitGitMergeIntent } from './application/use-cases/commands/merges/submit-git-merge-intent/submit-git-merge-intent.use-case.js';
import { PurgeTaskGitLinks } from './application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';
import { ListTaskGitLinks } from './application/use-cases/queries/links/list-task-git-links/list-task-git-links.use-case.js';
import { GitLinkChangedOutbox } from './infrastructure/messaging/outbox/links/git-link-changed-outbox.adapter.js';
import { DrizzleGitLinkRepository } from './infrastructure/persistence/drizzle/repositories/links/drizzle-git-link.repository.js';
import { DrizzleTaskGitLinkReader } from './infrastructure/persistence/drizzle/repositories/links/drizzle-task-git-link-reader.repository.js';
import { DrizzleGitMergeIntentRepository } from './infrastructure/persistence/drizzle/repositories/merges/drizzle-git-merge-intent.repository.js';
import { DrizzleGitHeadChecksUnitOfWork } from './infrastructure/persistence/drizzle/transactions/checks/drizzle-git-head-checks.unit-of-work.js';
import { DrizzleGitDispatchUnitOfWork } from './infrastructure/persistence/drizzle/transactions/dispatch/drizzle-git-dispatch.unit-of-work.js';
import { DrizzleGitLinkSettlement } from './infrastructure/persistence/drizzle/transactions/dispatch/drizzle-git-link-settlement.unit-of-work.js';
import { DrizzleGitAdmissionUnitOfWork } from './infrastructure/persistence/drizzle/transactions/deliveries/drizzle-git-admission.unit-of-work.js';
import { DrizzleGitWebhookBindingUnitOfWork } from './infrastructure/persistence/drizzle/transactions/bindings/drizzle-git-webhook-binding.unit-of-work.js';
import { DrizzleGitLinkMaintenanceUnitOfWork } from './infrastructure/persistence/drizzle/transactions/maintenance/drizzle-git-link-maintenance.unit-of-work.js';
import { DrizzleGitMergeIntentUnitOfWork } from './infrastructure/persistence/drizzle/transactions/merges/drizzle-git-merge-intent.unit-of-work.js';
import { finishGitLinkProjectionMigration } from './infrastructure/persistence/drizzle/transactions/links/finish-git-link-projection.unit-of-work.js';
import { DrizzleGitPurgeUnitOfWork } from './infrastructure/persistence/drizzle/transactions/purge/drizzle-git-purge.unit-of-work.js';
import { GitHeadChecksJobsProducer } from './infrastructure/jobs/pg-boss/checks/git-head-checks.adapter.js';
import { GitDispatchJobsProducer } from './infrastructure/jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import { GitMergeIntentJobsProducer } from './infrastructure/jobs/pg-boss/merges/git-merge-intent.adapter.js';
import {
  verifyGitHubWebhook,
  verifyGitLabWebhook,
} from './infrastructure/adapters/provider-signatures/git-webhook-signature.adapter.js';
import { GitTaskHttpAdapter } from './infrastructure/adapters/task-service/git-task-http.adapter.js';
import { GitLinksController } from './presentation/http/controllers/links/git-links.controller.js';
import { GitWebhooksController } from './presentation/http/controllers/deliveries/git-webhooks.controller.js';
import { runGitWebhookBindingCommand } from './presentation/cli/commands/bindings/manage-git-webhook-binding.command.js';
import { GitHeadChecksJobHandler } from './presentation/jobs/handlers/checks/git-head-checks.handler.js';
import { GitDispatchJobHandler } from './presentation/jobs/handlers/dispatch/git-dispatch.handler.js';
import { GitLinkMaintenanceJobHandler } from './presentation/jobs/handlers/maintenance/git-link-maintenance.handler.js';
import { GitMergeIntentJobHandler } from './presentation/jobs/handlers/merges/git-merge-intent.handler.js';
import { GitPurgeJobHandler } from './presentation/jobs/handlers/purge/git-purge.handler.js';
import { TaskPurgedHandler } from './presentation/messaging/handlers/purge/task-purged.handler.js';

const linkDispatchWorker = Symbol('GitLinkDispatchWorker');
const versionedLinkDispatchWorker = Symbol('GitLinkDispatchV2Worker');
const taskAction = Symbol('GitTaskAction');

async function createTaskAction(config: AppConfig): Promise<GitTaskAction> {
  const privateJwk = config.INTERNAL_TOKEN_PRIVATE_JWK;
  const baseUrl = config.TASK_SERVICE_URL;
  if (privateJwk === undefined || baseUrl === undefined) {
    const unavailable = (): Promise<never> =>
      Promise.reject(new Error('The Task action transport is not configured.'));
    return { apply: unavailable, submitMergeIntent: unavailable };
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

/** Existing links keep receiving terminal task purges while new link admission pauses. */
function linksMaintained(config: AppConfig): boolean {
  return config.GIT_LINK_EVENTS_ENABLED || config.GIT_LINK_PURGE_ENABLED;
}

/** Composition root for inbound Git provider webhooks and the task Git link read. */
@Module({
  controllers: [GitWebhooksController, GitLinksController],
  providers: [
    GitDispatchJobsProducer,
    GitHeadChecksJobsProducer,
    GitMergeIntentJobsProducer,
    {
      provide: taskAction,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => createTaskAction(config),
    },
    {
      provide: AdmitGitWebhook,
      inject: [TenantTransactionRunner, CONFIG, GitDispatchJobsProducer, GitHeadChecksJobsProducer],
      useFactory: (
        runner: TenantTransactionRunner<DatabaseSchema>,
        config: AppConfig,
        jobs: GitDispatchJobsProducer,
        headChecks: GitHeadChecksJobsProducer,
      ) =>
        new AdmitGitWebhook(
          new DrizzleGitAdmissionUnitOfWork(
            runner,
            config.GIT_WEBHOOK_RECEIVERS,
            jobs,
            config.GIT_LINK_EVENTS_ENABLED ? new DrizzleGitLinkRepository() : undefined,
            headChecks,
          ),
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
      inject: [
        TenantTransactionRunner,
        OutboxWriter,
        GitDispatchJobsProducer,
        GitMergeIntentJobsProducer,
        taskAction,
      ],
      useFactory: (
        runner: TenantTransactionRunner<DatabaseSchema>,
        outboxWriter: OutboxWriter,
        jobs: GitDispatchJobsProducer,
        mergeJobs: GitMergeIntentJobsProducer,
        task: GitTaskAction,
      ) => {
        const settlement = new DrizzleGitLinkSettlement(
          new DrizzleGitLinkRepository(),
          new GitLinkChangedOutbox(outboxWriter),
          new DrizzleGitMergeIntentRepository(),
          mergeJobs,
        );
        const work = new DrizzleGitDispatchUnitOfWork(
          runner,
          (scope, claim, receiverId, placement) =>
            settlement.record(scope, claim, receiverId, placement),
          { decide: decideGitCheckPrerequisites, jobs },
        );
        return new DispatchGitDelivery(work, task);
      },
    },
    {
      provide: SubmitGitMergeIntent,
      inject: [TenantTransactionRunner, GitMergeIntentJobsProducer, taskAction],
      useFactory: (
        runner: TenantTransactionRunner<DatabaseSchema>,
        jobs: GitMergeIntentJobsProducer,
        task: GitTaskAction,
      ) => new SubmitGitMergeIntent(new DrizzleGitMergeIntentUnitOfWork(runner, jobs), task),
    },
    {
      provide: RefreshGitHeadChecks,
      inject: [TenantTransactionRunner, GitDispatchJobsProducer, GitHeadChecksJobsProducer],
      useFactory: (
        runner: TenantTransactionRunner<DatabaseSchema>,
        dispatch: GitDispatchJobsProducer,
        pages: GitHeadChecksJobsProducer,
      ) =>
        new RefreshGitHeadChecks(
          new DrizzleGitHeadChecksUnitOfWork(
            runner,
            new DrizzleGitLinkRepository(),
            dispatch,
            pages,
          ),
        ),
    },
    {
      provide: GitHeadChecksJobHandler,
      inject: [JobWorkerRegistry, RefreshGitHeadChecks],
      useFactory: (workers: JobWorkerRegistry, refresh: RefreshGitHeadChecks) =>
        new GitHeadChecksJobHandler(workers, refresh, GIT_HEAD_CHECKS_QUEUE.name),
    },
    {
      provide: RunGitLinkMaintenance,
      inject: [SystemTransactionRunner, TenantTransactionRunner, GitMergeIntentJobsProducer],
      useFactory: (
        runner: SystemTransactionRunner<DatabaseSchema>,
        tenants: TenantTransactionRunner<DatabaseSchema>,
        jobs: GitMergeIntentJobsProducer,
      ) =>
        new RunGitLinkMaintenance(new DrizzleGitLinkMaintenanceUnitOfWork(runner, tenants, jobs)),
    },
    {
      provide: ListTaskGitLinks,
      inject: [TenantTransactionRunner],
      useFactory: (runner: TenantTransactionRunner<DatabaseSchema>) =>
        new ListTaskGitLinks(new DrizzleTaskGitLinkReader(runner)),
    },
    {
      provide: GitDispatchJobHandler,
      inject: [JobWorkerRegistry, DispatchGitDelivery],
      useFactory: (workers: JobWorkerRegistry, dispatch: DispatchGitDelivery) =>
        new GitDispatchJobHandler(workers, dispatch, GIT_DISPATCH_QUEUE.name),
    },
    {
      provide: linkDispatchWorker,
      inject: [JobWorkerRegistry, DispatchGitDelivery],
      useFactory: (workers: JobWorkerRegistry, dispatch: DispatchGitDelivery) =>
        new GitDispatchJobHandler(workers, dispatch, GIT_LINK_DISPATCH_QUEUE.name),
    },
    {
      provide: versionedLinkDispatchWorker,
      inject: [JobWorkerRegistry, DispatchGitDelivery],
      useFactory: (workers: JobWorkerRegistry, dispatch: DispatchGitDelivery) =>
        new GitDispatchJobHandler(workers, dispatch, GIT_LINK_DISPATCH_V2_QUEUE.name),
    },
    // Like the link dispatch worker, these run whatever the flags: a draining link queue still
    // records merge intents, which must be submitted, and links that must be maintained.
    {
      provide: GitMergeIntentJobHandler,
      inject: [JobWorkerRegistry, SubmitGitMergeIntent],
      useFactory: (workers: JobWorkerRegistry, submit: SubmitGitMergeIntent) =>
        new GitMergeIntentJobHandler(workers, submit, GIT_MERGE_INTENT_QUEUE.name),
    },
    {
      provide: GitLinkMaintenanceJobHandler,
      inject: [JobWorkerRegistry, JobScheduler, RunGitLinkMaintenance],
      useFactory: (
        workers: JobWorkerRegistry,
        scheduler: JobScheduler,
        maintenance: RunGitLinkMaintenance,
      ) =>
        new GitLinkMaintenanceJobHandler(
          workers,
          scheduler,
          maintenance,
          GIT_LINK_MAINTENANCE_QUEUE.name,
        ),
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
        linksMaintained(config) ? new TaskPurgedHandler(consumers, purge) : null,
    },
    {
      provide: GitPurgeJobHandler,
      inject: [CONFIG, JobWorkerRegistry, PurgeTaskGitLinks],
      useFactory: (config: AppConfig, workers: JobWorkerRegistry, purge: PurgeTaskGitLinks) =>
        linksMaintained(config)
          ? new GitPurgeJobHandler(workers, purge, GIT_PURGE_QUEUE.name)
          : null,
    },
  ],
})
export class GitWebhooksModule {
  // #region Methods
  /** Completes this capability's migrations on a migrator session outside a transaction. */
  public static finishMigrations(
    client: Parameters<typeof finishGitLinkProjectionMigration>[0],
  ): Promise<void> {
    return finishGitLinkProjectionMigration(client);
  }

  /** Runs a local operator command with only the application database connection. */
  public static runBindingCommand(args: readonly string[]): Promise<number> {
    return runGitWebhookBindingCommand(args, async (input) => {
      const config = loadConfig(z.object({ DATABASE_URL: databaseConfigShape.DATABASE_URL }));
      return DrizzleGitWebhookBindingUnitOfWork.withConnection(config.DATABASE_URL, (work) =>
        new ManageGitWebhookBinding(work).execute(input),
      );
    });
  }
  // #endregion
}
