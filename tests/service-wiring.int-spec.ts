import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InternalTokenSigner, loadConfig, runWithOrganizationContext } from '@cadenway/nest-common';
import type {
  Ed25519PrivateJwk,
  Ed25519PublicJwk,
  OrganizationContext,
} from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { JobProducer } from '@cadenway/nest-jobs/runtime';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule, createIntegrationApplication } from '../src/app.module.js';
import { appConfigSchema } from '../src/config/app-config.js';
import { ListTaskGitLinksInternalResponse } from '@cadenway/contracts/validators/internal/integration-service';

import { GIT_LINK_DISPATCH_QUEUE, GIT_LINK_MAINTENANCE_QUEUE } from '../src/config/job-queues.js';
import { DispatchGitDelivery } from '../src/modules/git-webhooks/application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';

// The service as main.ts assembles it, on a disposable PostgreSQL and NATS. `@cadenway/nest-testing`
// does not export its container fixtures yet and a service never depends on `testcontainers` itself,
// so the dependencies are those of compose.dev.yaml, started as a throwaway Compose project on free
// ports: PostgreSQL with the two roles of cadenway-ops, NATS with its authorization (the
// `integration` user, its subjects, the inbox prefix `_INBOX.integration`) and its three streams.

/** Compose file of the development dependencies. */
const composeFile: string = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));

/** Throwaway project name: it never touches the data of the developer's own dev stack. */
const project = `cadenway-integration-service-test-${String(process.pid)}`;
const legacyOutboxId = randomUUID();
const legacyOutboxTenantId = randomUUID();
/** A request link recorded by the release before the Git link projection, closed on its head. */
const legacyLinkTenantId = '01938f6e-0000-7000-8000-0000000000a1';
const legacyLinkReceiverId = '01938f6e-0000-7000-8000-0000000000a2';
const legacyLinkTaskId = '01938f6e-0000-7000-8000-0000000000a3';
const legacyHeadObservedAtMs = Date.UTC(2026, 10, 7, 15, 0);

/**
 * Host port of NATS. Fixed for the run, unlike the ephemeral port of PostgreSQL: the service must
 * find NATS at the same address after the test restarts it, and Docker gives an ephemeral mapping a
 * new port at each start.
 */
let natsHostPort = '0';

/** Atelier Nord, the organization of the mockup. */
const atelierNordId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';

/** Another organization, which must never see a row of Atelier Nord. */
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';

/** Camille Martin (CM), the member of Atelier Nord the mockup signs in as. */
const camilleMartinId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';

const gitReceiverId = '01938f6e-0000-7000-8000-000000000061';
const gitOrganizationId = '01938f6e-0000-7000-8000-000000000060';
const gitSpaceId = '01938f6e-0000-7000-8000-000000000062';
const gitIntegrationId = '01938f6e-0000-7000-8000-000000000063';
const gitTaskId = '01938f6e-0000-7000-8000-000000000064';
const gitListId = '01938f6e-0000-7000-8000-000000000065';
const gitTaskIdsByPath = new Map([
  ['/internal/v1/tasks/CAD-483/git-status-actions', '01938f6e-0000-7000-8000-000000000066'],
  ['/internal/v1/tasks/CAD-484/git-status-actions', '01938f6e-0000-7000-8000-000000000067'],
  ['/internal/v1/tasks/CAD-485/git-status-actions', '01938f6e-0000-7000-8000-000000000068'],
  ['/internal/v1/tasks/CAD-486/git-status-actions', '01938f6e-0000-7000-8000-000000000069'],
  ['/internal/v1/tasks/CAD-487/git-status-actions', '01938f6e-0000-7000-8000-000000000070'],
  ['/internal/v1/tasks/CAD-488/git-status-actions', '01938f6e-0000-7000-8000-000000000071'],
]);
const gitFixtureKey = randomBytes(32).toString('hex');

/** The tables of the platform module, as the kit names them. */
const platformTables = [
  'event_versions',
  'idempotency_keys',
  'outbox_events',
  'processed_events',
] as const;
const gitTables = [
  'git_check_observations',
  'git_dispatch_claims',
  'git_links',
  'git_merge_intents',
  'git_purged_tasks',
  'git_repository_mappings',
  'git_webhook_deliveries',
  'git_webhook_delivery_ids',
  'git_webhook_receivers',
] as const;

/**
 * Runs `docker compose` on the throwaway project.
 *
 * @param args - Compose command and its arguments.
 * @returns The standard output.
 */
function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: natsHostPort },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Runs the NATS command line of the `nats-streams` container against the broker of the project.
 *
 * @param env - Variables that replace the `admin` credentials of the container for this call.
 * @param args - Arguments of the `nats` command.
 * @returns Whether the broker accepted the command.
 */
function brokerAccepts(env: Readonly<Record<string, string>>, ...args: readonly string[]): boolean {
  const variables = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  try {
    compose('exec', '-T', ...variables, 'nats-streams', 'nats', '--timeout', '2s', ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a port of the loopback interface that nothing listens on.
 *
 * @returns A free port, released before it is returned.
 */
async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('The probe server has no TCP address.'));
        } else {
          resolve(String(address.port));
        }
      });
    });
  });
}

/**
 * Reads the published host port of a service of the project.
 *
 * @param service - Compose service.
 * @param port - Port inside the container.
 * @returns The host port.
 */
function hostPort(service: string, port: string): string {
  return compose('port', service, port).trim().split(':').at(-1) ?? '';
}

/**
 * Creates an Ed25519 key pair in the JWK forms the internal token uses.
 *
 * @returns The public key for the verifier and the private key for a signer.
 */
function keyPair(): {
  readonly publicJwk: Ed25519PublicJwk;
  readonly privateJwk: Ed25519PrivateJwk;
} {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) {
    throw new Error('Node returned an Ed25519 JWK without its key material.');
  }
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: 'test-api-gateway' };
  return { publicJwk, privateJwk: { ...publicJwk, d } };
}

/**
 * The organization context of a member of an organization, as the internal token gives it.
 *
 * @param organizationId - Organization of the context.
 * @returns The context the tenant runner reads.
 */
function memberOf(organizationId: string): OrganizationContext {
  return {
    organizationId,
    actor: { type: 'user', id: camilleMartinId },
    role: null,
    scopes: [],
  };
}

/**
 * Applies the migrations with `src/migrate.ts`, the entry point of the migration container, as
 * the migrator role. Each call imports the module afresh, as each container start runs it once.
 */
async function runMigrator(): Promise<void> {
  vi.resetModules();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await import('../src/migrate.js');
  } finally {
    log.mockRestore();
  }
}

/** Queues a legacy outbox row on the immediately preceding production schema. */
async function prepareLegacyOutbox(pool: pg.Pool): Promise<void> {
  const source = fileURLToPath(new URL('../migrations', import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), 'cadenway-integration-migrations-'));
  try {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as {
      readonly entries: readonly { readonly tag: string }[];
    };
    const last = journal.entries.findIndex(({ tag }) => tag === '0007_outbox_leases');
    if (last < 0) throw new Error('The outbox lease expansion is missing from the journal.');
    const entries = journal.entries.slice(0, last);
    await mkdir(join(temporary, 'meta'));
    await writeFile(
      join(temporary, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    for (const { tag } of entries) {
      await copyFile(join(source, `${tag}.sql`), join(temporary, `${tag}.sql`));
    }
    await migrate(drizzle({ client: pool }), { migrationsFolder: temporary });
    await runWithOrganizationContext(memberOf(legacyOutboxTenantId), () =>
      new TenantTransactionRunner(pool).run(async ({ client }) => {
        await client.query(
          `insert into outbox_events (id, event_name, subject, stream, organization_id, payload)
           values ($1, 'git.wiring-probe.v1', 'evt.git.wiring-probe.v1', 'EVENTS', $2,
                   jsonb_build_object('id', $1::uuid::text, 'organizationId', $2::uuid::text))`,
          [legacyOutboxId, legacyOutboxTenantId],
        );
      }),
    );
    await runWithOrganizationContext(memberOf(legacyLinkTenantId), () =>
      new TenantTransactionRunner(pool).run(async ({ client }) => {
        await client.query(
          "insert into git_webhook_receivers (organization_id, id, provider) values ($1, $2, 'github')",
          [legacyLinkTenantId, legacyLinkReceiverId],
        );
        await client.query(
          `insert into git_links
             (organization_id, receiver_id, provider, task_id, task_key, identity_hash, identity,
              status, version, head_sha, head_first_observed_at_ms, head_last_observed_at_ms,
              checks_attempt_id, checks_completed_at_ms)
           values ($1, $2, 'github', $3, 'CAD-497', $4, $5::jsonb, 'closed', 3, $6, $7, $7, 11, $8)`,
          [
            legacyLinkTenantId,
            legacyLinkReceiverId,
            legacyLinkTaskId,
            'a'.repeat(64),
            JSON.stringify({
              organizationId: legacyLinkTenantId,
              receiverId: legacyLinkReceiverId,
              binding: { provider: 'github', repositoryId: 91, installationId: 51 },
              taskId: legacyLinkTaskId,
              kind: 'pull-request',
              requestNumber: 31,
            }),
            'b'.repeat(40),
            legacyHeadObservedAtMs,
            legacyHeadObservedAtMs + 60_000,
          ],
        );
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Releases the shutdown held by `ShutdownGate`. */
let releaseShutdown: () => void = () => undefined;

/** Settles once `releaseShutdown` is called. */
const shutdownReleased = new Promise<void>((resolve) => {
  releaseShutdown = resolve;
});

/**
 * Holds the shutdown after readiness turned down and before the listener closes, the way a slow
 * handler or relay pass would, so the probes can be read during the stop.
 */
@Injectable()
class ShutdownGate implements BeforeApplicationShutdown {
  public async beforeApplicationShutdown(): Promise<void> {
    await shutdownReleased;
  }
}

/** A route of the application that declares no exemption, like every business route will. */
@Controller('internal/v1/wiring-probe')
class WiringProbeController {
  @Get()
  public probe(): { readonly reached: true } {
    return { reached: true };
  }
}

describe('integration-service wiring', () => {
  const gateway = keyPair();
  const automation = keyPair();
  const integration = keyPair();
  const taskCommands: {
    path: string | undefined;
    key: string | string[] | undefined;
    body: unknown;
  }[] = [];
  let heldTaskReply: { readonly path: string; readonly released: Promise<void> } | undefined;
  const task = createHttpServer((incoming, outgoing) => {
    const body: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => body.push(chunk));
    incoming.on('end', () => {
      const command = JSON.parse(Buffer.concat(body).toString('utf8')) as {
        readonly status?: unknown;
      };
      taskCommands.push({
        path: incoming.url,
        key: incoming.headers['idempotency-key'],
        body: command,
      });
      const respond = (): void => {
        if (outgoing.destroyed) return;
        outgoing.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, no-store',
        });
        outgoing.end(
          JSON.stringify({
            disposition: command.status === null ? 'no_op' : 'applied',
            taskId: gitTaskIdsByPath.get(incoming.url ?? '') ?? gitTaskId,
            listId: gitListId,
            spaceId: gitSpaceId,
          }),
        );
      };
      if (
        heldTaskReply !== undefined &&
        heldTaskReply.path === incoming.url &&
        command.status === 'review'
      ) {
        void heldTaskReply.released.then(respond);
        return;
      }
      respond();
    });
  });
  let app: NestExpressApplication | undefined;
  let signer: InternalTokenSigner;
  let migrator: pg.Pool;

  /**
   * The running application.
   *
   * @returns The application created in `beforeAll`.
   */
  function service(): NestExpressApplication {
    if (app === undefined) {
      throw new Error('The application did not start.');
    }
    return app;
  }

  beforeAll(async () => {
    natsHostPort = await freePort();
    compose(
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'nats',
      'nats-streams',
    );
    const postgresPort = hostPort('postgres', '5432');

    vi.stubEnv(
      'MIGRATION_DATABASE_URL',
      `postgres://integration_migrator:integration_migrator@127.0.0.1:${postgresPort}/integration`,
    );
    migrator = new pg.Pool({
      connectionString: `postgres://integration_migrator:integration_migrator@127.0.0.1:${postgresPort}/integration`,
      max: 1,
      // Kept open for the whole run, so the stop of PostgreSQL below always reaches it.
      idleTimeoutMillis: 0,
    });
    // The client is terminated (57P01) when a test stops PostgreSQL; the pool reports it as an
    // `error` event, which would otherwise be an uncaught exception.
    migrator.on('error', () => undefined);
    await prepareLegacyOutbox(migrator);
    await runMigrator();

    vi.stubEnv('PORT', '3018');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv(
      'DATABASE_URL',
      `postgres://integration_app:integration_app@127.0.0.1:${postgresPort}/integration`,
    );
    vi.stubEnv('NATS_URL', `nats://127.0.0.1:${natsHostPort}`);
    vi.stubEnv('NATS_USER', 'integration');
    vi.stubEnv('NATS_PASSWORD', 'integration');
    vi.stubEnv('INTERNAL_TOKEN_AUDIENCE', 'integration-service');
    await new Promise<void>((resolve) => task.listen(0, '127.0.0.1', resolve));
    const taskAddress = task.address();
    if (taskAddress === null || typeof taskAddress === 'string')
      throw new Error('Task fixture has no port.');
    vi.stubEnv('TASK_SERVICE_URL', `http://127.0.0.1:${String(taskAddress.port)}`);
    vi.stubEnv('INTERNAL_TOKEN_PRIVATE_JWK', JSON.stringify(integration.privateJwk));
    vi.stubEnv('GIT_LINK_EVENTS_ENABLED', 'true');
    vi.stubEnv(
      'GIT_WEBHOOK_RECEIVERS',
      JSON.stringify([
        {
          bindingId: gitReceiverId,
          organizationId: gitOrganizationId,
          provider: 'github',
          revision: 1,
          signingSecret: gitFixtureKey,
        },
      ]),
    );
    vi.stubEnv(
      'INTERNAL_TOKEN_TRUSTED_ISSUERS',
      JSON.stringify({
        'api-gateway': [gateway.publicJwk],
        'automation-service': [automation.publicJwk],
      }),
    );

    @Module({
      imports: [AppModule],
      controllers: [WiringProbeController],
      providers: [ShutdownGate],
    })
    class ProbedApplicationModule {}

    // As main.ts: the configuration is read inside the start-up, never when a module is imported.
    const config = loadConfig(appConfigSchema);
    app = await createIntegrationApplication(config, ProbedApplicationModule, {
      write: (): void => undefined,
    });
    await app.init();
    signer = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gateway.privateJwk,
    });

    const tenant = service().get(TenantTransactionRunner);
    await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
      tenant.run(async (tx) => {
        await tx.client.query(
          `insert into git_webhook_receivers (organization_id, id, provider)
           values ($1, $2, 'github')`,
          [gitOrganizationId, gitReceiverId],
        );
        await tx.client.query(
          `insert into git_repository_mappings
             (organization_id, receiver_id, provider, repository_id, installation_id,
              space_id, integration_id, mapping_author_user_id)
           values ($1, $2, 'github', 81, 41, $3, $4, $5)`,
          [gitOrganizationId, gitReceiverId, gitSpaceId, gitIntegrationId, camilleMartinId],
        );
      }),
    );
  });

  afterAll(async () => {
    try {
      releaseShutdown();
      await app?.close();
      if (task.listening) {
        await new Promise<void>((resolve) => {
          task.close(() => {
            resolve();
          });
        });
      }
      await migrator.end();
    } finally {
      vi.unstubAllEnvs();
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('applies its migration as the migrator role, which owns the platform tables', async () => {
    const tables = await migrator.query<{ tablename: string; tableowner: string }>(
      `select tablename, tableowner from pg_tables where schemaname = 'public' order by tablename`,
    );
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );

    expect(tables.rows).toEqual(
      [...platformTables, ...gitTables].sort().map((tablename) => ({
        tablename,
        tableowner: 'integration_migrator',
      })),
    );
    expect(journal.rows).toEqual([{ applied: 9 }]);
  });

  it('applies nothing when the migrator runs again', async () => {
    await runMigrator();

    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: 9 }]);
  });

  it('retains a signed closure admitted before the earlier opening can record the link', async () => {
    const taskKey = 'CAD-485';
    const path = `/internal/v1/tasks/${taskKey}/git-status-actions`;
    let allowReply: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      allowReply = resolve;
    });
    const tenant = service().get(TenantTransactionRunner);
    const actor = await signer.sign('integration-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const repository = { id: 81 };
    const requestNumber = 225;
    const send = (action: 'opened' | 'closed', deliveryId: string) => {
      const raw = JSON.stringify({
        repository,
        installation: { id: 41 },
        number: requestNumber,
        action,
        pull_request: {
          number: requestNumber,
          state: action === 'opened' ? 'open' : 'closed',
          merged: false,
          head: { ref: 'renamed-branch', repo: repository },
          base: { ref: 'main', repo: repository },
          title: action === 'opened' ? 'Correction CAD-485' : 'Correction',
        },
      });
      return request(service().getHttpServer())
        .post(`/internal/v1/webhooks/github?bindingId=${gitReceiverId}`)
        .set('Authorization', `Bearer ${actor}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Delivery', deliveryId)
        .set('X-GitHub-Event', 'pull_request')
        .set(
          'X-Hub-Signature-256',
          `sha256=${createHmac('sha256', gitFixtureKey).update(raw).digest('hex')}`,
        )
        .send(raw);
    };
    const opening = randomUUID();
    const closing = randomUUID();
    heldTaskReply = { path, released };
    try {
      await send('opened', opening).expect(204);
      await vi.waitFor(
        () => {
          expect(taskCommands.some((command) => command.path === path)).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
      await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
        tenant.run(async ({ client }) => {
          await client.query(
            `insert into git_webhook_deliveries
               (organization_id, receiver_id, provider, receiver_revision, digest, work)
             select d.organization_id, d.receiver_id, d.provider,
                    case when variant.name = 'old-revision' then d.receiver_revision + 1
                         else d.receiver_revision end,
                    repeat(variant.digest, 64),
                    case variant.name
                      when 'old-author' then jsonb_set(d.work, '{mapping,mappingAuthorUserId}', to_jsonb($2::text))
                      when 'legacy' then d.work - 'recordLink'
                      else d.work
                    end
               from git_webhook_deliveries d join git_webhook_delivery_ids a
                 on (d.organization_id, d.id) = (a.organization_id, a.receipt_id)
               cross join (values ('old-revision', 'b'), ('old-author', 'c'), ('legacy', 'd')) variant(name, digest)
              where a.delivery_id = $1`,
            [opening, gitIntegrationId],
          );
        }),
      );
      await send('closed', closing).expect(204);
      const admitted = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
        tenant.run(({ client }) =>
          client.query(
            `select work->'prerequisiteIds' as prerequisites, work->'fact'->'taskKeys' as targets,
                  (select receipt_id from git_webhook_delivery_ids where delivery_id = $1) as opening
             from git_webhook_deliveries d join git_webhook_delivery_ids a
               on (d.organization_id, d.id) = (a.organization_id, a.receipt_id)
            where a.delivery_id = $2`,
            [opening, closing],
          ),
        ),
      );
      const rows = admitted.rows as readonly {
        readonly opening: string;
        readonly prerequisites: readonly string[];
        readonly targets: readonly string[];
      }[];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.opening).toEqual(expect.any(String));
      expect(row?.prerequisites).toEqual([row?.opening]);
      expect(row?.targets).toEqual([taskKey]);
    } finally {
      heldTaskReply = undefined;
      allowReply();
    }
    await vi.waitFor(
      async () => {
        const events = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
          tenant.run(({ client }) =>
            client.query(
              `select event_name, (payload->>'version')::int as version
             from outbox_events where payload->>'taskKey' = $1 order by version`,
              [taskKey],
            ),
          ),
        );
        expect(events.rows).toEqual([
          { event_name: 'git.pr-opened.v1', version: 1 },
          { event_name: 'git.pr-closed.v1', version: 2 },
        ]);
      },
      { timeout: 15_000 },
    );
  });

  it('resumes a signed check once its preceding opening is settled', async () => {
    const taskKey = 'CAD-488';
    const path = `/internal/v1/tasks/${taskKey}/git-status-actions`;
    const tenant = service().get(TenantTransactionRunner);
    const actor = await signer.sign('integration-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const repository = { id: 81 };
    const sha = 'a'.repeat(40);
    const requestNumber = 227;
    const pullRequest = {
      number: requestNumber,
      state: 'open',
      merged: false,
      head: { ref: 'cad-488-revision', sha, repo: repository },
      base: { ref: 'main', repo: repository },
      title: 'Révision CAD-488',
      body: null,
      updated_at: '2026-11-08T16:18:43Z',
    };
    const openingBody = JSON.stringify({
      repository,
      installation: { id: 41 },
      action: 'opened',
      number: requestNumber,
      pull_request: pullRequest,
    });
    const checkBody = JSON.stringify({
      repository,
      installation: { id: 41 },
      action: 'completed',
      check_suite: {
        id: 316,
        status: 'completed',
        conclusion: 'success',
        head_branch: pullRequest.head.ref,
        head_sha: sha,
        updated_at: '2026-11-08T16:18:44Z',
        pull_requests: [pullRequest],
      },
    });
    const send = (body: string, deliveryId: string, event: string) =>
      request(service().getHttpServer())
        .post(`/internal/v1/webhooks/github?bindingId=${gitReceiverId}`)
        .set('Authorization', `Bearer ${actor}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Delivery', deliveryId)
        .set('X-GitHub-Event', event)
        .set(
          'X-Hub-Signature-256',
          `sha256=${createHmac('sha256', gitFixtureKey).update(body).digest('hex')}`,
        )
        .send(body);
    const query = (statement: string, values: readonly unknown[]) =>
      runWithOrganizationContext(memberOf(gitOrganizationId), () =>
        tenant.run(({ client }) => client.query(statement, [...values])),
      );
    const events = () =>
      query(
        `select event_name, (payload->>'version')::int as version
           from outbox_events where organization_id = $1 and payload->>'taskKey' = $2
          order by version`,
        [gitOrganizationId, taskKey],
      );
    const openingId = randomUUID();
    const checkId = randomUUID();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const producer = service().get(JobProducer);
    const enqueue = vi.spyOn(producer, 'enqueue');
    heldTaskReply = { path, released };
    try {
      await send(openingBody, openingId, 'pull_request').expect(204);
      await vi.waitFor(
        () => {
          expect(taskCommands.some((command) => command.path === path)).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
      await send(checkBody, checkId, 'check_suite').expect(204);
      const admitted = await query(
        `select d.id, d.work->'prerequisiteIds' as prerequisites,
                (select receipt_id from git_webhook_delivery_ids
                  where organization_id = $1 and receiver_id = $2 and delivery_id = $3) as opening
           from git_webhook_deliveries d join git_webhook_delivery_ids a
             on (d.organization_id, d.id) = (a.organization_id, a.receipt_id)
          where a.organization_id = $1 and a.receiver_id = $2 and a.delivery_id = $4`,
        [gitOrganizationId, gitReceiverId, openingId, checkId],
      );
      const row = admitted.rows[0] as
        { id: string; opening: string; prerequisites: readonly string[] } | undefined;
      expect(row?.prerequisites).toEqual([row?.opening]);
      if (row === undefined) throw new Error('The signed check was not admitted.');
      await vi.waitFor(
        () => {
          const deferred = enqueue.mock.calls.filter(
            ([, queue, payload, options]) =>
              queue === GIT_LINK_DISPATCH_QUEUE.name &&
              typeof payload === 'object' &&
              payload !== null &&
              'deliveryId' in payload &&
              payload.deliveryId === row.id &&
              options?.startAfter instanceof Date,
          );
          expect(deferred).not.toHaveLength(0);
        },
        { timeout: 12_000, interval: 50 },
      );
      await vi.waitFor(
        async () => {
          const deferredJob = await migrator.query(
            `select id from pgboss.job
              where name = $1 and data->>'organizationId' = $2
                and data->'payload'->>'deliveryId' = $3 and data->'payload'->>'taskKey' = $4
                and start_after > created_on`,
            [GIT_LINK_DISPATCH_QUEUE.name, gitOrganizationId, row.id, taskKey],
          );
          expect(deferredJob.rows.length).toBeGreaterThan(0);
        },
        { timeout: 3_000, interval: 50 },
      );
      expect(
        taskCommands.filter(({ path: commandPath, body }) =>
          commandPath === path && typeof body === 'object' && body !== null && 'status' in body
            ? body.status === null
            : false,
        ),
      ).toEqual([]);
      expect((await events()).rows).toEqual([]);

      heldTaskReply = undefined;
      release();
      await service().get(DispatchGitDelivery).execute({
        organizationId: gitOrganizationId,
        deliveryId: row.opening,
        taskKey,
      });
      await vi.waitFor(
        async () => {
          expect((await events()).rows).toEqual([
            { event_name: 'git.pr-opened.v1', version: 1 },
            // The suite was stored before the opening created the link, which announces it.
            { event_name: 'git.link-updated.v1', version: 2 },
          ]);
        },
        { timeout: 15_000, interval: 100 },
      );
      await send(checkBody, checkId, 'check_suite').expect(204);
      expect((await events()).rows).toEqual([
        { event_name: 'git.pr-opened.v1', version: 1 },
        { event_name: 'git.link-updated.v1', version: 2 },
      ]);
      const commands = taskCommands.filter(({ path: commandPath }) => commandPath === path);
      const reviewKeys = commands
        .filter(
          ({ body }) =>
            typeof body === 'object' &&
            body !== null &&
            'status' in body &&
            body.status === 'review',
        )
        .map(({ key }) => key);
      expect(new Set(reviewKeys).size).toBe(1);
      // The deferred check still authorizes its target once, and changes nothing more.
      await vi.waitFor(
        () => {
          expect(
            taskCommands.filter(
              ({ path: commandPath, body }) =>
                commandPath === path &&
                typeof body === 'object' &&
                body !== null &&
                'status' in body &&
                body.status === null,
            ),
          ).toHaveLength(1);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect((await events()).rows).toHaveLength(2);
    } finally {
      heldTaskReply = undefined;
      release();
      enqueue.mockRestore();
    }
  });

  it('records a merge for both existing links and closes only the task still referenced', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const token = await signer.sign('integration-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const repository = { id: 81 };
    const number = 226;
    const send = (merged: boolean, deliveryId: string) => {
      const payload = JSON.stringify({
        repository,
        installation: { id: 41 },
        number,
        action: merged ? 'closed' : 'opened',
        pull_request: {
          number,
          state: merged ? 'closed' : 'open',
          merged,
          head: { ref: 'feature', repo: repository },
          base: { ref: 'main', repo: repository },
          title: merged ? 'Closes CAD-487' : 'Feature CAD-486 and CAD-487',
        },
      });
      return request(service().getHttpServer())
        .post(`/internal/v1/webhooks/github?bindingId=${gitReceiverId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Delivery', deliveryId)
        .set('X-GitHub-Event', 'pull_request')
        .set(
          'X-Hub-Signature-256',
          `sha256=${createHmac('sha256', gitFixtureKey).update(payload).digest('hex')}`,
        )
        .send(payload);
    };
    const events = () =>
      runWithOrganizationContext(memberOf(gitOrganizationId), () =>
        tenant.run(({ client }) =>
          client.query(
            `select link.task_key, link.status, (event.payload->>'version')::int as version,
                    event.event_name
                from git_links link join outbox_events event
                  on event.organization_id = link.organization_id
                  and event.payload->>'gitLinkId' = link.id::text
              where link.task_key in ('CAD-486', 'CAD-487')
                and event.status = 'sent'
              order by link.task_key, (event.payload->>'version')::int`,
          ),
        ),
      );
    await send(false, randomUUID()).expect(204);
    await vi.waitFor(
      async () => {
        expect((await events()).rows).toEqual([
          { task_key: 'CAD-486', status: 'open', version: 1, event_name: 'git.pr-opened.v1' },
          { task_key: 'CAD-487', status: 'open', version: 1, event_name: 'git.pr-opened.v1' },
        ]);
      },
      { timeout: 15_000, interval: 50 },
    );

    const mergeDeliveryId = randomUUID();
    await send(true, mergeDeliveryId).expect(204);
    await send(true, mergeDeliveryId).expect(204);
    await vi.waitFor(
      async () => {
        expect((await events()).rows).toEqual([
          { task_key: 'CAD-486', status: 'merged', version: 1, event_name: 'git.pr-opened.v1' },
          { task_key: 'CAD-486', status: 'merged', version: 2, event_name: 'git.pr-merged.v1' },
          { task_key: 'CAD-487', status: 'merged', version: 1, event_name: 'git.pr-opened.v1' },
          { task_key: 'CAD-487', status: 'merged', version: 2, event_name: 'git.pr-merged.v1' },
        ]);
      },
      { timeout: 15_000, interval: 50 },
    );
    // The merge only authorizes each link; the merge intent of CAD-487 then submits done.
    await vi.waitFor(
      () => {
        for (const [taskKey, statuses] of [
          ['CAD-486', ['review', null]],
          ['CAD-487', ['review', null, 'done']],
        ] as const) {
          expect(
            taskCommands
              .filter(({ path }) => path === `/internal/v1/tasks/${taskKey}/git-status-actions`)
              .map(({ body }) => body),
          ).toEqual(statuses.map((status) => expect.objectContaining({ status }) as unknown));
        }
      },
      { timeout: 15_000, interval: 50 },
    );
  });

  it('accepts one pending Git action for two signed deliveries of the same raw body', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const gatewayToken = await signer.sign('integration-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const repository = { id: 81 };
    const sha = 'e'.repeat(40);
    const branch = 'cad-482-ecran-connexion-sso';
    const payload = {
      repository,
      installation: { id: 41 },
      action: 'opened',
      number: 214,
      pull_request: {
        number: 214,
        state: 'open',
        merged: false,
        head: { ref: branch, sha, repo: repository },
        base: { ref: 'main', repo: repository },
        title: 'Écran de connexion (CAD-482)',
        body: null,
        updated_at: '2026-11-08T16:18:43Z',
      },
    };
    const body = `\n${JSON.stringify(payload, null, 2)}\n`;
    const digest = createHash('sha256').update(body).digest('hex');
    const signature = `sha256=${createHmac('sha256', gitFixtureKey).update(body).digest('hex')}`;
    const path = `/internal/v1/webhooks/github?bindingId=${gitReceiverId}`;
    const deliver = (authorization: string, key = signature, raw = body, event = 'pull_request') =>
      request(service().getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${authorization}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Delivery', randomUUID())
        .set('X-GitHub-Event', event)
        .set('X-Hub-Signature-256', key)
        .send(raw);

    const results = await Promise.all([deliver(gatewayToken), deliver(gatewayToken)]);
    expect(results.map((result) => result.status)).toEqual([204, 204]);
    expect(results.map((result) => result.headers['cache-control'])).toEqual([
      'private, no-store',
      'private, no-store',
    ]);
    const admitted = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
      tenant.run((tx) =>
        tx.client.query(
          `select work->'fact'->>'trigger' as trigger, work->'fact'->'taskKeys' as keys
             from git_webhook_deliveries where receiver_id = $1 and digest = $2`,
          [gitReceiverId, digest],
        ),
      ),
    );
    expect(admitted.rows).toEqual([{ trigger: 'pr_open', keys: ['CAD-482'] }]);
    const refusal = await deliver(gatewayToken, `sha256=${'0'.repeat(64)}`);
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({ code: 'webhook.authentication-failed' });
    expect(refusal.headers['cache-control']).toBe('private, no-store');

    await vi.waitFor(
      async () => {
        const claim = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
          tenant.run((tx) =>
            tx.client.query(
              `select claim.id, claim.disposition
               from git_dispatch_claims claim join git_webhook_deliveries delivery
                 on delivery.organization_id = claim.organization_id and delivery.id = claim.delivery_id
               where delivery.receiver_id = $1 and delivery.digest = $2 and claim.status = 'completed'`,
              [gitReceiverId, digest],
            ),
          ),
        );
        const claims = claim.rows as readonly {
          readonly id: string;
          readonly disposition: string;
        }[];
        expect(claims.map(({ disposition }) => disposition)).toEqual(['applied']);
        expect(typeof claims[0]?.id).toBe('string');
        const links = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
          tenant.run((transaction) =>
            transaction.client.query(
              `select link.task_key, link.status, (event.payload->>'version')::int as version,
                      event.event_name, event.payload
                 from git_links link join outbox_events event
                   on event.organization_id = link.organization_id
                   and event.payload->>'gitLinkId' = link.id::text
                 where link.task_key = 'CAD-482' and event.event_name = 'git.pr-opened.v1'`,
            ),
          ),
        );
        expect(links.rows).toHaveLength(1);
        expect(links.rows[0]).toMatchObject({
          task_key: 'CAD-482',
          status: 'open',
          version: 1,
          event_name: 'git.pr-opened.v1',
          payload: {
            taskKey: 'CAD-482',
            spaceId: gitSpaceId,
            listId: gitListId,
            changed: ['state'],
            actor: { type: 'git', id: gitIntegrationId },
          },
        });
        expect(
          taskCommands.filter(
            ({ path }) => path === '/internal/v1/tasks/CAD-482/git-status-actions',
          ),
        ).toEqual([
          {
            path: '/internal/v1/tasks/CAD-482/git-status-actions',
            key: claims[0]?.id,
            body: {
              provider: 'github',
              mappingAuthorUserId: camilleMartinId,
              spaceId: gitSpaceId,
              status: 'review',
            },
          },
        ]);
      },
      { timeout: 15_000, interval: 100 },
    );

    const checks = JSON.stringify({
      repository,
      installation: payload.installation,
      action: 'completed',
      check_suite: {
        id: 315,
        status: 'completed',
        conclusion: 'success',
        head_branch: branch,
        head_sha: sha,
        updated_at: '2026-11-08T16:18:44Z',
        pull_requests: [payload.pull_request],
      },
    });
    const checkSignature = `sha256=${createHmac('sha256', gitFixtureKey).update(checks).digest('hex')}`;
    await deliver(gatewayToken, checkSignature, checks, 'check_suite').expect(204);
    await deliver(gatewayToken, checkSignature, checks, 'check_suite').expect(204);
    await vi.waitFor(
      async () => {
        const events = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
          tenant.run(({ client }) =>
            client.query(
              `select (payload->>'version')::int as version from outbox_events
               where event_name = 'git.checks-completed.v1' and payload->>'taskKey' = 'CAD-482'`,
            ),
          ),
        );
        expect(events.rows).toEqual([{ version: 2 }]);
      },
      { timeout: 15_000, interval: 100 },
    );

    const closed = JSON.stringify({
      ...payload,
      action: 'closed',
      pull_request: {
        ...payload.pull_request,
        state: 'closed',
        head: { ...payload.pull_request.head, ref: 'renamed' },
        title: 'No longer references any task',
        updated_at: '2026-11-08T16:18:45Z',
      },
    });
    const closingSignature = `sha256=${createHmac('sha256', gitFixtureKey).update(closed).digest('hex')}`;
    await deliver(gatewayToken, closingSignature, closed).expect(204);
    await vi.waitFor(
      async () => {
        const closedLink = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
          tenant.run(({ client }) =>
            client.query(
              `select link.status, link.version::int, event.event_name, event.payload->'changed' as changed
             from git_links link join outbox_events event
               on event.organization_id = link.organization_id
               and event.payload->>'gitLinkId' = link.id::text
             where link.task_key = 'CAD-482' and event.event_name in ('git.checks-completed.v1', 'git.pr-closed.v1')
             order by (event.payload->>'version')::int`,
            ),
          ),
        );
        expect(closedLink.rows).toEqual([
          {
            status: 'closed',
            version: 3,
            event_name: 'git.checks-completed.v1',
            changed: ['checks'],
          },
          { status: 'closed', version: 3, event_name: 'git.pr-closed.v1', changed: ['state'] },
        ]);
        expect(
          taskCommands.findLast(
            ({ path }) => path === '/internal/v1/tasks/CAD-482/git-status-actions',
          )?.body,
        ).toMatchObject({ status: null });
      },
      { timeout: 15_000, interval: 100 },
    );
  });

  it('rolls back the receipt, alias and first job when admission cannot enqueue every target', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const providerDeliveryId = randomUUID();
    const gatewayToken = await signer.sign('integration-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const repository = { id: 81 };
    const raw = JSON.stringify({
      repository,
      installation: { id: 41 },
      action: 'opened',
      number: 215,
      pull_request: {
        number: 215,
        state: 'open',
        merged: false,
        head: { ref: 'cad-483-revision', repo: repository },
        base: { ref: 'main', repo: repository },
        title: 'Révision de CAD-483 et CAD-484',
        body: null,
      },
    });
    const digest = createHash('sha256').update(raw).digest('hex');
    const signature = `sha256=${createHmac('sha256', gitFixtureKey).update(raw).digest('hex')}`;
    const deliver = () =>
      request(service().getHttpServer())
        .post(`/internal/v1/webhooks/github?bindingId=${gitReceiverId}`)
        .set('Authorization', `Bearer ${gatewayToken}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Delivery', providerDeliveryId)
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', signature)
        .send(raw);

    const producer = service().get(JobProducer);
    const enqueue = producer.enqueue.bind(producer);
    let firstJobId: string | undefined;
    let visibleInsideAdmission = false;
    const interrupted = vi
      .spyOn(producer, 'enqueue')
      .mockImplementationOnce(async (transaction, queue, payload, options) => {
        expect(queue).toBe(GIT_LINK_DISPATCH_QUEUE.name);
        const result = await enqueue(transaction, queue, payload, options);
        const stored = await transaction.client.query(
          'select id from pgboss.job where name = $1 and id = $2',
          [queue, result.jobId],
        );
        firstJobId = result.jobId;
        visibleInsideAdmission = stored.rows.length === 1 && !result.duplicate;
        return result;
      })
      .mockRejectedValueOnce(new Error('Fixture rejected the second job.'));
    try {
      const failed = await deliver();
      expect(failed.status).toBe(503);
      expect(failed.body).toMatchObject({ code: 'integration.unavailable' });
      expect(interrupted).toHaveBeenCalledTimes(2);
    } finally {
      interrupted.mockRestore();
    }
    expect(visibleInsideAdmission).toBe(true);
    if (firstJobId === undefined) throw new Error('The first job was never inserted.');

    const receiptCounts = () =>
      runWithOrganizationContext(memberOf(gitOrganizationId), () =>
        tenant.run((tx) =>
          tx.client.query(
            `select
               (select count(*)::int from git_webhook_deliveries
                 where organization_id = $1 and receiver_id = $2 and digest = $3) as receipts,
               (select count(*)::int from git_webhook_delivery_ids
                 where organization_id = $1 and receiver_id = $2 and delivery_id = $4) as aliases`,
            [gitOrganizationId, gitReceiverId, digest, providerDeliveryId],
          ),
        ),
      );
    expect((await receiptCounts()).rows).toEqual([{ receipts: 0, aliases: 0 }]);
    const leftover = await migrator.query('select id from pgboss.job where name = $1 and id = $2', [
      GIT_LINK_DISPATCH_QUEUE.name,
      firstJobId,
    ]);
    expect(leftover.rows).toEqual([]);
    const paths = [
      '/internal/v1/tasks/CAD-483/git-status-actions',
      '/internal/v1/tasks/CAD-484/git-status-actions',
    ];
    const sentPaths = () =>
      taskCommands
        .flatMap(({ path }) => (path !== undefined && paths.includes(path) ? [path] : []))
        .toSorted();
    expect(sentPaths()).toEqual([]);

    expect((await deliver()).status).toBe(204);
    expect((await receiptCounts()).rows).toEqual([{ receipts: 1, aliases: 1 }]);
    await vi.waitFor(
      async () => {
        const claims = await runWithOrganizationContext(memberOf(gitOrganizationId), () =>
          tenant.run((tx) =>
            tx.client.query(
              `select claim.task_key, claim.status, claim.disposition
               from git_dispatch_claims claim join git_webhook_delivery_ids alias
                 on alias.organization_id = claim.organization_id and alias.receipt_id = claim.delivery_id
               where alias.organization_id = $1 and alias.receiver_id = $2 and alias.delivery_id = $3
               order by claim.task_key`,
              [gitOrganizationId, gitReceiverId, providerDeliveryId],
            ),
          ),
        );
        expect(claims.rows).toEqual([
          { task_key: 'CAD-483', status: 'completed', disposition: 'applied' },
          { task_key: 'CAD-484', status: 'completed', disposition: 'applied' },
        ]);
        expect(sentPaths()).toEqual(paths);
      },
      { timeout: 15_000, interval: 100 },
    );
  });

  it('forces row-level security on the tables that carry an organization', async () => {
    const tables = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r'
        order by relname`,
    );
    const policies = await migrator.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'public' order by tablename`,
    );

    expect(tables.rows).toEqual([
      { relname: 'event_versions', relrowsecurity: true, relforcerowsecurity: true },
      ...gitTables.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
      { relname: 'idempotency_keys', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'outbox_events', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'processed_events', relrowsecurity: false, relforcerowsecurity: false },
    ]);
    expect(policies.rows).toEqual([
      { tablename: 'event_versions', policyname: 'event_versions_organization_isolation' },
      ...gitTables.map((tablename) => ({ tablename, policyname: `${tablename}_tenant_isolation` })),
      { tablename: 'idempotency_keys', policyname: 'idempotency_keys_organization_isolation' },
      { tablename: 'outbox_events', policyname: 'outbox_events_organization_isolation' },
    ]);
  });

  it('answers the liveness probe without a token', async () => {
    const response = await request(service().getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('is ready once PostgreSQL answers the application role and NATS the integration user', async () => {
    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      details: { postgres: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('refuses a route of the application without an internal token', async () => {
    const response = await request(service().getHttpServer()).get('/internal/v1/wiring-probe');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(response.body).toMatchObject({ status: 401, code: 'auth.token-missing' });
  });

  it('serves a route to a trusted issuer acting for a member of the organization', async () => {
    const token = await signer.sign('integration-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reached: true });
  });

  it('completes the Git link projection migration on links recorded before it', async () => {
    const indexes = await migrator.query<{ relname: string; valid: boolean }>(
      `select c.relname, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname in ('git_links_task_page_index', 'git_links_head_lookup_index',
                            'git_links_reconciliation_index')
        order by c.relname`,
    );
    expect(indexes.rows).toEqual([
      { relname: 'git_links_head_lookup_index', valid: true },
      { relname: 'git_links_reconciliation_index', valid: true },
      { relname: 'git_links_task_page_index', valid: true },
    ]);
    const unvalidated = await migrator.query(
      `select conname from pg_constraint
        where conrelid = 'public.git_links'::regclass and not convalidated`,
    );
    expect(unvalidated.rows).toEqual([]);

    const tenant = service().get(TenantTransactionRunner);
    const stored = await runWithOrganizationContext(memberOf(legacyLinkTenantId), () =>
      tenant.run(({ client }) =>
        client.query(
          `select lifecycle_observed_at_ms::double precision as lifecycle, member_observed_at_ms,
                  checks, checks_completed_at_ms::double precision as completed
             from git_links where task_key = 'CAD-497'`,
        ),
      ),
    );
    expect(stored.rows).toEqual([
      {
        lifecycle: legacyHeadObservedAtMs,
        member_observed_at_ms: {},
        checks: null,
        completed: legacyHeadObservedAtMs + 60_000,
      },
    ]);
    const token = await signer.sign('integration-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: legacyLinkTenantId,
    });
    const response = await request(service().getHttpServer())
      .get('/internal/v1/tasks/CAD-497/git-links')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const page = ListTaskGitLinksInternalResponse.parse(response.body);
    expect(page).toMatchObject({
      items: [
        {
          taskKey: 'CAD-497',
          kind: 'pull-request',
          state: 'closed',
          number: 31,
          providerRepositoryId: 91,
          headSha: 'b'.repeat(40),
          // A completion recorded without an aggregate is not returned.
          checksCompletedAt: null,
          version: 3,
        },
      ],
      nextCursor: null,
    });
    expect(page.items[0]).not.toHaveProperty('checks');
  });

  it('guards the task Git link read with the issuer, actor and organization of the contract', async () => {
    const read = (token?: string) => {
      const call = request(service().getHttpServer()).get('/internal/v1/tasks/CAD-497/git-links');
      return token === undefined ? call : call.set('Authorization', `Bearer ${token}`);
    };
    const automationSigner = await InternalTokenSigner.create({
      issuer: 'automation-service',
      privateJwk: automation.privateJwk,
    });
    const cases = [
      [undefined, 401, 'auth.token-missing'],
      [
        await automationSigner.sign('integration-service', {
          actor: { type: 'user', id: camilleMartinId },
          organizationId: legacyLinkTenantId,
        }),
        403,
        'auth.issuer-not-allowed',
      ],
      [
        await signer.sign('integration-service', {
          actor: { type: 'system', id: 'api-gateway' },
          organizationId: legacyLinkTenantId,
        }),
        403,
        'auth.actor-not-allowed',
      ],
      [
        await signer.sign('integration-service', {
          actor: { type: 'user', id: camilleMartinId },
          organizationId: null,
        }),
        403,
        'auth.organization-required',
      ],
    ] as const;
    for (const [token, status, code] of cases) {
      const response = await read(token);
      expect({ status: response.status, code: (response.body as { code?: string }).code }).toEqual({
        status,
        code,
      });
    }
    // Another organization reads no link of CAD-497.
    const other = await read(
      await signer.sign('integration-service', {
        actor: { type: 'user', id: camilleMartinId },
        organizationId: atelierNordId,
      }),
    );
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ items: [], nextCursor: null });
  });

  it('runs the merge intent worker and schedules the link maintenance', async () => {
    const schedules = await migrator.query(
      'select name, cron, timezone from pgboss.schedule where name = $1',
      [GIT_LINK_MAINTENANCE_QUEUE.name],
    );
    expect(schedules.rows).toEqual([
      { name: GIT_LINK_MAINTENANCE_QUEUE.name, cron: '17 * * * *', timezone: 'UTC' },
    ]);
  });

  it('refuses a token signed for another service', async () => {
    const token = await signer.sign('document-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'auth.token-invalid',
      details: { reason: 'audience' },
    });
  });

  it('lets the application role read and write the platform tables of its organization only', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const countAll = async (organizationId: string): Promise<Record<string, number>> =>
      runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (tx) => {
          const counts = await tx.client.query(
            `select 'outbox_events' as name, count(*)::int as rows from outbox_events
             union all select 'event_versions', count(*)::int from event_versions
             union all select 'idempotency_keys', count(*)::int from idempotency_keys`,
          );
          const rows = counts.rows as readonly { readonly name: string; readonly rows: number }[];
          return Object.fromEntries(rows.map(({ name, rows: count }) => [name, count]));
        }),
      );

    // Sent rather than pending: the relay must have nothing to publish.
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        await tx.client.query(
          `insert into outbox_events
             (id, event_name, subject, stream, organization_id, payload, status, sent_at)
           values (uuidv7(), 'git.wiring-probe.v1', 'evt.git.wiring-probe.v1', 'EVENTS', $1,
                   '{}', 'sent', now())`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into event_versions (consumer, organization_id, aggregate_key, version)
           values ('integration-service__wiring-probe', $1, 'task:CAD-482', 1)`,
          [atelierNordId],
        );
        await tx.client.query(
          `update event_versions set version = 2 where aggregate_key = 'task:CAD-482'`,
        );
        await tx.client.query(
          `insert into idempotency_keys
             (organization_id, key, request_fingerprint, response_status, response_headers,
              expires_at)
           values ($1, 'wiring-probe', 'fingerprint', 201, '{}', now() + interval '1 day')`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into processed_events (consumer, event_id)
           values ('integration-service__wiring-probe', uuidv7())`,
        );
      }),
    );

    expect(await countAll(atelierNordId)).toEqual({
      outbox_events: 1,
      event_versions: 1,
      idempotency_keys: 1,
    });
    expect(await countAll(otherOrganizationId)).toEqual({
      outbox_events: 0,
      event_versions: 0,
      idempotency_keys: 0,
    });
    await expect(
      runWithOrganizationContext(memberOf(otherOrganizationId), () =>
        tenant.run((tx) =>
          tx.client.query(
            `insert into event_versions (consumer, organization_id, aggregate_key, version)
             values ('integration-service__wiring-probe', $1, 'task:CAD-483', 1)`,
            [atelierNordId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const deleted = await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        const counts: number[] = [];
        for (const table of platformTables) {
          counts.push((await tx.client.query(`delete from ${table} returning 1`)).rows.length);
        }
        return counts;
      }),
    );
    expect(deleted).toEqual([1, 1, 1, 1]);
  });

  it('refuses any change of structure to the application role', async () => {
    const system = service().get(SystemTransactionRunner);
    const statements = [
      'create table wiring_probe (id integer)',
      'alter table outbox_events add column wiring_probe integer',
      'alter table outbox_events no force row level security',
      'drop table processed_events',
      'truncate idempotency_keys',
      'create schema wiring_probe',
    ];

    for (const statement of statements) {
      await expect(system.run((tx) => tx.client.query(statement))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('keeps the application role out of the journal of the migrations', async () => {
    const system = service().get(SystemTransactionRunner);

    // A rewritten journal would make the next migration run apply migrations again.
    await expect(
      system.run((tx) => tx.client.query('delete from drizzle.__drizzle_migrations')),
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for schema drizzle' });
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: 9 }]);
  });

  it('publishes successive outbox events and remains ready', async () => {
    const leases = await migrator.query(
      `select
         (select indisvalid from pg_index where indexrelid = 'public.outbox_events_lease_expiry_index'::regclass) as index_valid,
         (select count(*)::int from pg_constraint where conrelid = 'public.outbox_events'::regclass
          and conname in ('outbox_events_lease_check', 'outbox_events_status_check') and convalidated)
         as validated_checks`,
    );
    expect(leases.rows).toEqual([{ index_valid: true, validated_checks: 2 }]);
    const outbox = service().get(SystemTransactionRunner);
    await vi.waitFor(
      async () => {
        const legacy = await outbox.run(({ client }) =>
          client.query(
            'select status, lease_token, lease_expires_at from outbox_events where id = $1',
            [legacyOutboxId],
          ),
        );
        expect(legacy.rows).toEqual([
          { status: 'sent', lease_token: null, lease_expires_at: null },
        ]);
      },
      { timeout: 10_000, interval: 100 },
    );
    const tenant = service().get(TenantTransactionRunner);
    const system = service().get(SystemTransactionRunner);
    for (let pass = 0; pass < 2; pass += 1) {
      const id = randomUUID();
      await runWithOrganizationContext(memberOf(atelierNordId), () =>
        tenant.run(async (tx) => {
          await tx.client.query(
            `insert into outbox_events
               (id, event_name, subject, stream, organization_id, payload)
             values ($1, 'git.wiring-probe.v1', 'evt.git.wiring-probe.v1', 'EVENTS', $2, $3)`,
            [id, atelierNordId, JSON.stringify({ id, organizationId: atelierNordId })],
          );
        }),
      );
      await vi.waitFor(
        async () => {
          const result = await system.run((tx) =>
            tx.client.query('select status from outbox_events where id = $1', [id]),
          );
          expect(result.rows).toEqual([{ status: 'sent' }]);
        },
        { timeout: 10_000, interval: 100 },
      );
    }
    const response = await request(service().getHttpServer()).get('/health/ready');
    expect(response.status).toBe(200);
  });

  it('runs against a broker that enforces the permissions of cadenway-ops', () => {
    const integration = { NATS_USER: 'integration', NATS_PASSWORD: 'integration' };

    expect(
      brokerAccepts(
        integration,
        '--inbox-prefix',
        '_INBOX.integration',
        'stream',
        'info',
        'EVENTS',
      ),
    ).toBe(true);
    expect(brokerAccepts(integration, 'stream', 'info', 'EVENTS')).toBe(false);
    expect(brokerAccepts(integration, 'pub', 'evt.task.wiring-probe', 'refused')).toBe(false);
    expect(brokerAccepts({ NATS_USER: '', NATS_PASSWORD: '' }, 'pub', 'evt.git.x', 'x')).toBe(
      false,
    );
  });

  it('stops being ready while NATS is down, and is ready again once it is back', async () => {
    compose('stop', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          status: 'error',
          info: { postgres: { status: 'up' } },
          error: { nats: { status: 'down' } },
        });
      },
      { timeout: 10_000, interval: 250 },
    );

    compose('start', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(200);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('stops being ready when its database is down', async () => {
    compose('stop', 'postgres');

    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'error',
      error: { postgres: { status: 'down' } },
    });
  });

  it('answers 503 on readiness and 200 on liveness as soon as it shuts down', async () => {
    const running = service();
    const closing = running.close();

    await vi.waitFor(
      async () => {
        const response = await request(running.getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          error: { shutdown: { status: 'down', message: 'shutting down' } },
        });
      },
      { timeout: 5_000, interval: 50 },
    );
    const live = await request(running.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);

    releaseShutdown();
    await closing;
    app = undefined;
  });
});
