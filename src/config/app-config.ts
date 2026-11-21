import {
  baseConfigShape,
  internalTokenSignerConfigShape,
  internalTokenVerifierConfigShape,
} from '@cadenway/nest-common';
import type {
  BaseConfig,
  InternalTokenSignerConfig,
  InternalTokenVerifierConfig,
} from '@cadenway/nest-common';
import { databaseConfigShape } from '@cadenway/nest-common/database';
import type { DatabaseConfig } from '@cadenway/nest-common/database';
import { messagingConfigShape } from '@cadenway/nest-messaging';
import type { MessagingConfig } from '@cadenway/nest-messaging';
import { z } from 'zod';

const gitReceiverSchema = z.strictObject({
  bindingId: z.uuidv7().transform((id) => id.toLowerCase()),
  organizationId: z.uuidv7().transform((id) => id.toLowerCase()),
  provider: z.enum(['github', 'gitlab']),
  revision: z.int().positive(),
  signingSecret: z.string().min(32).max(1024),
});

const gitWebhookReceiversSchema = z
  .string()
  .default('[]')
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Expected a JSON array of receiver settings.' });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(gitReceiverSchema)
      .refine(
        (receivers) =>
          new Set(receivers.map((receiver) => receiver.bindingId)).size === receivers.length,
        { message: 'Receiver IDs must be distinct.' },
      ),
  );

/**
 * Type AppConfig
 *
 * @description
 * Variables the running service reads, validated when the application is created: by `loadConfig`
 * in `main.ts` for the options of `createApplication`, and by `ConfigModule` for the providers that
 * inject `CONFIG`.
 *
 * - `NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`: `baseConfigShape` of `@cadenway/nest-common`;
 *   `PORT` is required, the others default to `production`, `info` and `false`.
 * - `DATABASE_URL`: the application role of this service's own database (`integration_app`),
 *   subject to row-level security and holding no DDL right.
 * - `DATABASE_TRANSACTION_MAX_ATTEMPTS`: total attempts for an outer PostgreSQL transaction.
 *   Defaults to 3. Set it to 1 to disable automatic retries.
 * - `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`: `messagingConfigShape` of `@cadenway/nest-messaging`.
 *   `NATS_URL` is required; the user (`integration`) and its password are optional for the kit,
 *   which accepts an anonymous local broker, but every broker of Cadenway refuses a connection
 *   without them.
 * - `INTERNAL_TOKEN_AUDIENCE` and `INTERNAL_TOKEN_TRUSTED_ISSUERS`: the `aud` this service accepts
 *   and the public keys of the backends allowed to call it.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is read by `telemetry.ts`, before the application exists.
 * `INTERNAL_TOKEN_ISSUER`, `INTERNAL_TOKEN_PRIVATE_JWK` and `TASK_SERVICE_URL` are set for the
 * calls of this service to task-service. A signing key and Task URL are required when a Git
 * webhook receiver is configured.
 *
 * @type {BaseConfig & DatabaseConfig & MessagingConfig & InternalTokenVerifierConfig}
 */
export type AppConfig = BaseConfig &
  DatabaseConfig &
  MessagingConfig &
  InternalTokenVerifierConfig &
  Pick<InternalTokenSignerConfig, 'INTERNAL_TOKEN_ISSUER'> & {
    readonly INTERNAL_TOKEN_PRIVATE_JWK?:
      InternalTokenSignerConfig['INTERNAL_TOKEN_PRIVATE_JWK'] | undefined;
    readonly TASK_SERVICE_URL?: string | undefined;
    readonly GIT_WEBHOOK_RECEIVERS: readonly z.output<typeof gitReceiverSchema>[];
    readonly GIT_LINK_EVENTS_ENABLED: boolean;
  };

/**
 * Constant appConfigSchema
 *
 * @description
 * Zod schema of `AppConfig`, composed from the shapes of `@cadenway/nest-common` and
 * `@cadenway/nest-messaging` so the names, defaults and validation stay those of the kit. A missing
 * or invalid variable makes `loadConfig` throw a `ConfigError` that names it without printing its
 * value.
 *
 * @type {z.ZodType<AppConfig>}
 */
export const appConfigSchema: z.ZodType<AppConfig> = z
  .object({
    ...baseConfigShape,
    ...databaseConfigShape,
    ...messagingConfigShape,
    ...internalTokenVerifierConfigShape,
    INTERNAL_TOKEN_ISSUER: z.literal('integration-service').default('integration-service'),
    INTERNAL_TOKEN_PRIVATE_JWK:
      internalTokenSignerConfigShape.INTERNAL_TOKEN_PRIVATE_JWK.optional(),
    TASK_SERVICE_URL: z.url({ protocol: /^https?$/u }).optional(),
    GIT_WEBHOOK_RECEIVERS: gitWebhookReceiversSchema,
    GIT_LINK_EVENTS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((config, ctx) => {
    if (config.GIT_WEBHOOK_RECEIVERS.length === 0) return;
    for (const name of ['INTERNAL_TOKEN_PRIVATE_JWK', 'TASK_SERVICE_URL'] as const) {
      if (config[name] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'Required for Git webhook dispatch.',
        });
      }
    }
  });

/**
 * Interface MigrationConfig
 *
 * @description
 * Variable the one-off migration container reads (`node dist/migrate.js`). The running service
 * never reads it: only the migrator role may change the structure of the database.
 */
export interface MigrationConfig {
  // #region Properties
  /**
   * Property MIGRATION_DATABASE_URL
   *
   * @description
   * Connection string of the migrator role (`integration_migrator`), which owns the tables and runs
   * the DDL. A secret; cadenway-ops passes it from `INTEGRATION_SERVICE_MIGRATION_DATABASE_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly MIGRATION_DATABASE_URL: string;
  // #endregion
}

/**
 * Constant migrationConfigSchema
 *
 * @description
 * Zod schema of `MigrationConfig`: a `postgres://` or `postgresql://` URL, like `DATABASE_URL`.
 *
 * @type {z.ZodType<MigrationConfig>}
 */
export const migrationConfigSchema: z.ZodType<MigrationConfig> = z.object({
  MIGRATION_DATABASE_URL: z.url({
    protocol: /^postgres(?:ql)?$/u,
    error: 'Expected the postgres:// URL of the migrator role.',
  }),
});
