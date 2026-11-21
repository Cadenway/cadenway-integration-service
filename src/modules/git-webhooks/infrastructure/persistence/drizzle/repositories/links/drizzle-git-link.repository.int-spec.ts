import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitLinkIdentity } from '../../../../../domain/policies/links/git-link-change.policy.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';
import { DrizzleGitLinkRepository } from './drizzle-git-link.repository.js';

const composeFile = fileURLToPath(
  new URL('../../../../../../../../compose.dev.yaml', import.meta.url),
);
const project = `cadenway-git-link-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const receiverId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const otherReceiverId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const taskId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const actor = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const binding = { provider: 'github' as const, repositoryId: 81, installationId: 41 };
const request = {
  kind: 'actionable',
  trigger: 'pr_open',
  requestNumber: 214,
  taskKeys: ['CAD-482'],
  closingTaskKeys: [],
} as const satisfies VerifiedGitDelivery;

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

describe('Git link persistence', () => {
  let pool: pg.Pool | undefined;
  let runner: TenantTransactionRunner;
  const links = new DrizzleGitLinkRepository();

  beforeAll(async () => {
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port is unavailable.');
    const migrator = new pg.Pool({
      connectionString: `postgres://integration_migrator:integration_migrator@127.0.0.1:${port}/integration`,
    });
    try {
      await migrate(drizzle({ client: migrator }), { migrationsFolder: 'migrations' });
    } finally {
      await migrator.end();
    }
    pool = new pg.Pool({
      connectionString: `postgres://integration_app:integration_app@127.0.0.1:${port}/integration`,
    });
    runner = new TenantTransactionRunner(pool);
    for (const [tenant, receiver] of [
      [organizationId, receiverId],
      [otherOrganizationId, otherReceiverId],
    ] as const) {
      await runWithOrganizationContext(
        { organizationId: tenant, actor: { type: 'user', id: actor }, role: null, scopes: [] },
        () =>
          runner.run(async (scope) => {
            await scope.client.query(
              "insert into git_webhook_receivers (organization_id, id, provider) values ($1, $2, 'github')",
              [tenant, receiver],
            );
          }),
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    compose('down', '--volumes', '--remove-orphans');
  });

  it('keeps one link and monotonic versions for concurrent and reordered deliveries', async () => {
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, request);
    const record = (fact: Extract<VerifiedGitDelivery, { kind: 'actionable' }>) =>
      runWithOrganizationContext(context, () =>
        runner.run(async (scope) => {
          await scope.client.query(
            'select id from git_webhook_receivers where organization_id = $1 and id = $2 for update',
            [organizationId, receiverId],
          );
          return links.record(scope, identity, fact, 'CAD-482');
        }),
      );

    const first = await Promise.all([record(request), record(request)]);
    const created = first.find((result) => result !== null);
    expect(first.filter((result) => result !== null)).toHaveLength(1);
    expect(created?.event).toEqual({ type: 'pull-request-opened', version: 1 });
    const merged = await record({ ...request, trigger: 'pr_merged' });
    expect(merged).toEqual({
      id: created?.id,
      event: { type: 'pull-request-merged', version: 2 },
    });
    expect(await record(request)).toBeNull();
  });

  it('rolls back a link with its transaction and isolates tenants', async () => {
    const fact = { ...request, trigger: 'branch', branch: 'CAD-482-Connexion' } as const;
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, fact);
    await expect(
      runWithOrganizationContext(context, () =>
        runner.run(async (scope) => {
          await links.record(scope, identity, fact, 'CAD-482');
          throw new Error('roll back link and outbox');
        }),
      ),
    ).rejects.toThrow('roll back link and outbox');
    const created = await runWithOrganizationContext(context, () =>
      runner.run((scope) => links.record(scope, identity, fact, 'CAD-482')),
    );
    expect(created?.event).toEqual({ type: 'branch-created', version: 1 });
    const otherContext = {
      organizationId: otherOrganizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    await expect(
      runWithOrganizationContext(otherContext, () =>
        runner.run((scope) => links.record(scope, identity, fact, 'CAD-482')),
      ),
    ).rejects.toThrow('tenant transaction');
    const visible = await runWithOrganizationContext(otherContext, () =>
      runner.run((scope) =>
        scope.client.query('select id from git_links where organization_id = $1', [
          otherOrganizationId,
        ]),
      ),
    );
    expect(visible.rows).toEqual([]);
  });

  it('permanently fences task links when purge races with a late delivery', async () => {
    const fact = {
      ...request,
      taskKeys: ['CAD-483'],
      trigger: 'branch',
      branch: 'CAD-483-a',
    } as const;
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, fact);
    const purge = () =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) => links.purge(scope, organizationId, 'CAD-483')),
      );
    const record = () =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) => links.record(scope, identity, fact, 'CAD-483')),
      );
    await Promise.all([purge(), record()]);
    expect(await record()).toBeNull();
    expect(await purge()).toEqual({ hasMore: false });
    const rows = await runWithOrganizationContext(context, () =>
      runner.run((scope) =>
        scope.client.query(
          'select id from git_links where organization_id = $1 and task_key = $2',
          [organizationId, 'CAD-483'],
        ),
      ),
    );
    expect(rows.rows).toEqual([]);
  });

  it('limits purge to 500 links while keeping the tombstone through the next pass', async () => {
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        await scope.client.query(
          `insert into git_links
            (organization_id, receiver_id, provider, task_id, task_key, identity_hash, identity, status, version)
           select $1, $2, 'github', $3, 'CAD-484', md5(n::text) || md5(n::text), '{}', 'open', 1
             from generate_series(1, 501) as n`,
          [organizationId, receiverId, taskId],
        );
      }),
    );
    const purge = () =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) => links.purge(scope, organizationId, 'CAD-484')),
      );
    expect(await purge()).toEqual({ hasMore: true });
    const remaining = await runWithOrganizationContext(context, () =>
      runner.run((scope) =>
        scope.client.query(
          'select count(*)::int as count from git_links where organization_id = $1 and task_key = $2',
          [organizationId, 'CAD-484'],
        ),
      ),
    );
    expect(remaining.rows).toEqual([{ count: 1 }]);
    const fact = { ...request, taskKeys: ['CAD-484'] };
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, fact);
    expect(
      await runWithOrganizationContext(context, () =>
        runner.run((scope) => links.record(scope, identity, fact, 'CAD-484')),
      ),
    ).toBeNull();
    expect(await purge()).toEqual({ hasMore: false });
  });
});
