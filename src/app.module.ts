import {
  CONFIG,
  ConfigModule,
  HealthModule,
  createApplication,
  postgresIndicator,
} from '@cadenway/nest-common';
import type { CreateApplicationOptions, PostgresProbe } from '@cadenway/nest-common';
import { DATABASE_POOL, DatabaseModule } from '@cadenway/nest-common/database';
import { JobsRuntimeModule } from '@cadenway/nest-jobs/runtime';
import {
  MessagingConnection,
  MessagingModule,
  messagingHealthIndicator,
} from '@cadenway/nest-messaging';
import { OutboxModule } from '@cadenway/nest-messaging/outbox';
import { Module } from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { appConfigSchema } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import {
  GIT_DISPATCH_QUEUE,
  GIT_HEAD_CHECKS_QUEUE,
  GIT_LINK_DISPATCH_QUEUE,
  GIT_LINK_DISPATCH_V2_QUEUE,
  GIT_LINK_MAINTENANCE_QUEUE,
  GIT_MERGE_INTENT_QUEUE,
  GIT_PURGE_QUEUE,
} from './config/job-queues.js';
import { GitWebhooksModule } from './modules/git-webhooks/git-webhooks.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';

/**
 * Class AppModule
 *
 * @description
 * Root module of the service. `createApplication` of `@cadenway/nest-common` wraps it with the
 * logs, the `application/problem+json` errors, the validation pipe, the internal token guard and
 * the other shared formats; this module declares what the service itself depends on. Importing it
 * reads no configuration: every module below is built when the application is created.
 *
 * - `ConfigModule` (`eager: false`): the environment is validated against `appConfigSchema` when
 *   the application is created and provided as `CONFIG`; an invalid one makes `createApplication`
 *   reject with the `ConfigError`, which `runApplication` writes as one line.
 * - `DatabaseModule`: the pool of this service's own database, opened as the application role of
 *   `DATABASE_URL`, the tenant and system transaction runners, and the `Idempotency-Key`
 *   interceptor for the routes marked `@Idempotent()`. The pool closes on shutdown.
 * - `MessagingModule`: the NATS connection of the `integration` user, with the inbox prefix
 *   `_INBOX.integration` the broker requires. The creation waits for the first connection, then
 *   checks that the `EVENTS` stream exists: cadenway-ops creates the streams
 *   (`manageStreams: false`), and only notification-service runs the dead-letter worker. The
 *   Git link publication and the Task purge subscription are enabled together by
 *   `GIT_LINK_EVENTS_ENABLED` after the broker grants the named durable.
 * - `OutboxModule`: the outbox writer, the PostgreSQL deduplicator and the relay, which polls
 *   `outbox_events` every second in a system transaction and publishes the pending rows. It runs in
 *   every replica; `for update skip locked` keeps two of them from publishing the same row.
 * - `JobsRuntimeModule`: the transactional producer and worker for verified Git actions. Startup
 *   verifies the queue provisioned by the migrator. The scheduler capability enables recovery of
 *   abandoned attempts, queue retention and monitoring of dead letters. Each dispatch owns its
 *   short tenant transactions around the Task call.
 * - `HealthModule`: `GET /health/live` answers as soon as the process runs; `GET /health/ready`
 *   answers 503 while PostgreSQL or NATS does not answer within 1 second, and from the start of a
 *   shutdown. Both routes are exempt from the internal token, every other route requires it.
 *   `shutdownDelayMs` is 0: nothing that routes to this internal service reads its readiness.
 *   Callers reach it through the Docker DNS of the `internal` network, which keeps returning a
 *   stopping container until it exits, whatever its health (checked on Docker 28.2), and the GitOps
 *   agent only waits for the new container to be healthy before it stops the old one. A delay would
 *   lengthen every stop, under the 10 second default grace period of Docker, without moving any
 *   request away; set it above the probe interval of a proxy if one ever routes on readiness.
 * - `PlatformModule`: the owner of the kit tables in the migrations of the service.
 *
 * Business modules under `src/modules/` are registered here as they are created.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ schema: appConfigSchema, eager: false }),
    DatabaseModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        connectionString: config.DATABASE_URL,
        applicationName: 'integration-service',
        idempotency: true,
        transactionMaxAttempts: config.DATABASE_TRANSACTION_MAX_ATTEMPTS,
      }),
    }),
    MessagingModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        service: 'integration-service',
        servers: config.NATS_URL,
        user: config.NATS_USER,
        password: config.NATS_PASSWORD,
        manageStreams: false,
        deadLetterWorker: false,
      }),
    }),
    OutboxModule.forRoot(),
    JobsRuntimeModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: { connectionString: config.DATABASE_URL },
        queues: [
          GIT_DISPATCH_QUEUE,
          GIT_LINK_DISPATCH_QUEUE,
          GIT_LINK_DISPATCH_V2_QUEUE,
          GIT_PURGE_QUEUE,
          GIT_MERGE_INTENT_QUEUE,
          GIT_HEAD_CHECKS_QUEUE,
          GIT_LINK_MAINTENANCE_QUEUE,
        ],
        capabilities: ['producer', 'worker', 'scheduler'],
        poolSize: 2,
        shutdownTimeoutMs: 8_000,
      }),
    }),
    HealthModule.forRootAsync({
      inject: [DATABASE_POOL, MessagingConnection],
      useFactory: (pool: PostgresProbe, connection: MessagingConnection) => ({
        indicators: [postgresIndicator(pool), messagingHealthIndicator(connection)],
        shutdownDelayMs: 0,
      }),
    }),
    PlatformModule,
    GitWebhooksModule,
  ],
})
export class AppModule {}

/** Completes the Git capability's migrations on a migrator session outside a transaction. */
export function finishIntegrationMigrations(
  client: Parameters<typeof GitWebhooksModule.finishMigrations>[0],
): Promise<void> {
  return GitWebhooksModule.finishMigrations(client);
}

/** Invokes the Git capability's operator command without starting the HTTP or broker listeners. */
export function runIntegrationGitBindingCommand(args: readonly string[]): Promise<number> {
  return GitWebhooksModule.runBindingCommand(args);
}

/** Applies private webhook routing, the shared raw body limit and internal-token verification. */
export async function createIntegrationApplication(
  config: Readonly<AppConfig>,
  applicationModule: Type | DynamicModule = AppModule,
  logDestination?: CreateApplicationOptions['logDestination'],
): Promise<NestExpressApplication> {
  const app = await createApplication(applicationModule, {
    service: 'integration-service',
    config,
    rawJsonPostPaths: ['/internal/v1/webhooks/github', '/internal/v1/webhooks/gitlab'],
    internalToken: {
      verifier: {
        audience: config.INTERNAL_TOKEN_AUDIENCE,
        trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
      },
    },
    ...(logDestination === undefined ? {} : { logDestination }),
  });
  const webhookPath = /^\/internal\/v1\/webhooks\/(?:github|gitlab)\/?$/iu;
  app.use(webhookPath, (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  app.use(
    webhookPath,
    (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
      response.setHeader('Cache-Control', 'private, no-store');
      next(error);
    },
  );
  return app;
}
