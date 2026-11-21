import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { provisionJobs } from '@cadenway/nest-jobs/provisioning';
import { JobProducer, JobsRuntimeModule } from '@cadenway/nest-jobs/runtime';
import { Test, type TestingModule } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GIT_PURGE_QUEUE } from '../../../../../../../config/job-queues.js';
import { PurgeTaskGitLinks } from '../../../../../application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';
import { DrizzleGitLinkRepository } from '../../repositories/links/drizzle-git-link.repository.js';
import { DrizzleGitPurgeUnitOfWork } from './drizzle-git-purge.unit-of-work.js';

const project = `cadenway-integration-git-purge-test-${String(process.pid)}`;
const durable = 'integration-service__purge-task-git-links';
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const eventId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const receiverId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const taskId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const taskKey = 'CAD-482';

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', resolve('compose.dev.yaml'), ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function inOrganization<T>(work: () => Promise<T>): Promise<T> {
  return runWithOrganizationContext(
    { organizationId, actor: { type: 'system', id: 'task-service' }, role: null, scopes: [] },
    work,
  );
}

describe('Git purge transaction and continuation', () => {
  let pool: pg.Pool | undefined;
  let runtime: TestingModule | undefined;
  let runner: TenantTransactionRunner;
  let purge: PurgeTaskGitLinks;

  beforeAll(async () => {
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port is unavailable.');
    const migrationUrl = `postgres://integration_migrator:integration_migrator@127.0.0.1:${port}/integration`;
    const migrator = new pg.Pool({ connectionString: migrationUrl });
    try {
      await migrate(drizzle({ client: migrator }), { migrationsFolder: resolve('migrations') });
      await provisionJobs({
        connection: { connectionString: migrationUrl },
        appRole: 'integration_app',
        queues: [GIT_PURGE_QUEUE],
      });
    } finally {
      await migrator.end();
    }
    const connectionString = `postgres://integration_app:integration_app@127.0.0.1:${port}/integration`;
    pool = new pg.Pool({ connectionString });
    runner = new TenantTransactionRunner(pool);
    runtime = await Test.createTestingModule({
      imports: [
        JobsRuntimeModule.forRoot({
          connection: { connectionString },
          queues: [GIT_PURGE_QUEUE],
          capabilities: ['producer'],
          poolSize: 2,
        }),
      ],
    }).compile();
    await runtime.init();
    purge = new PurgeTaskGitLinks(
      new DrizzleGitPurgeUnitOfWork(
        runner,
        new DrizzleGitLinkRepository(),
        runtime.get(JobProducer),
      ),
    );
    await inOrganization(() =>
      runner.run(async ({ client }) => {
        await client.query(
          "insert into git_webhook_receivers (organization_id, id, provider) values ($1, $2, 'github')",
          [organizationId, receiverId],
        );
        await client.query(
          `insert into git_links (
             organization_id, receiver_id, provider, task_id, task_key, identity_hash, identity,
             status, version
           )
           select $1, $2, 'github', $3, $4, lpad(to_hex(link), 64, '0'), '{}', 'created', 1
           from generate_series(1, 1001) as links(link)`,
          [organizationId, receiverId, taskId, taskKey],
        );
      }),
    );
  });

  afterAll(async () => {
    try {
      await runtime?.close();
      await pool?.end();
    } finally {
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('rolls back the broker receipt, marker, bounded batch and continuation together', async () => {
    const first = {
      organizationId,
      eventId,
      taskKey,
      batch: 0,
      signal: new AbortController().signal,
    };
    const counts = () =>
      inOrganization(() =>
        runner.run(async ({ client }) => {
          const result = await client.query(
            `select
               (select count(*)::int from processed_events where consumer = $1 and event_id = $2) as receipts,
               (select count(*)::int from git_purged_tasks where task_key = $3) as markers,
               (select count(*)::int from git_links where task_key = $3) as links,
               (select count(*)::int from pgboss.job where name = $4) as jobs`,
            [durable, eventId, taskKey, GIT_PURGE_QUEUE.name],
          );
          return result.rows[0];
        }),
      );
    const admit = (rollback: boolean) =>
      inOrganization(() =>
        runner.run(async ({ client }) => {
          await client.query('insert into processed_events (consumer, event_id) values ($1, $2)', [
            durable,
            eventId,
          ]);
          await purge.execute(first);
          expect(await counts()).toEqual({ receipts: 1, markers: 1, links: 501, jobs: 1 });
          if (rollback) throw new Error('Force the broker transaction to roll back.');
        }),
      );

    await expect(admit(true)).rejects.toThrow('Force the broker transaction to roll back.');
    expect(await counts()).toEqual({ receipts: 0, markers: 0, links: 1001, jobs: 0 });
    await admit(false);

    // A standalone worker commits another bounded pass under the tenant from its job envelope.
    await purge.execute({ ...first, batch: 1 });
    expect(await counts()).toEqual({ receipts: 1, markers: 1, links: 1, jobs: 2 });
    await purge.execute({ ...first, batch: 2 });
    expect(await counts()).toEqual({ receipts: 1, markers: 1, links: 0, jobs: 2 });
  });
});
