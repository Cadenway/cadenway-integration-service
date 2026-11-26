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
import type { GitCheckObservation } from '../../../../../domain/value-objects/checks/git-check-observation.value-object.js';
import { DrizzleGitCheckObservationRepository } from '../checks/drizzle-git-check-observation.repository.js';
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
  const observations = new DrizzleGitCheckObservationRepository();

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
    const created = first.find((result) => result?.events.length === 1);
    expect(first.flatMap((result) => result?.events ?? [])).toEqual([
      { type: 'pull-request-opened', version: 1 },
    ]);
    expect(new Set(first.map((result) => result?.id)).size).toBe(1);
    const merged = await record({ ...request, trigger: 'pr_merged' });
    expect(merged).toEqual({
      id: created?.id,
      events: [{ type: 'pull-request-merged', version: 2 }],
      reconciliation: 'unchanged',
    });
    expect(await record(request)).toEqual({
      id: created?.id,
      events: [],
      reconciliation: 'unchanged',
    });
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
    expect(created?.events).toEqual([{ type: 'branch-created', version: 1 }]);
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

  it('requires a signed reference for a merge to establish a link that does not exist', async () => {
    const fact = {
      ...request,
      trigger: 'pr_merged',
      requestNumber: 231,
      referencedTaskKeys: [],
    } as const;
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, fact);
    await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        expect(await links.record(scope, identity, fact, 'CAD-482')).toBeNull();
        const explicit = { ...fact, referencedTaskKeys: ['CAD-482'] };
        expect((await links.record(scope, identity, explicit, 'CAD-482'))?.events).toEqual([
          { type: 'pull-request-merged', version: 1 },
        ]);
      }),
    );
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

  it('projects checks stored before the link and before its head update, and rejects stale retries', async () => {
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const opened = {
      ...request,
      requestNumber: 215,
      taskKeys: ['CAD-485'],
      head: { sha: shaA, observedAtMs: 100 },
    } as const;
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, opened);
    const repository = {
      organizationId,
      receiverId,
      provider: 'github' as const,
      repositoryId: 81,
    };
    const observe = (observation: GitCheckObservation) =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) => observations.record(scope, repository, observation)),
      );
    const suite = (
      headSha: string,
      attemptId: number,
      at: number,
      conclusion: string | null,
    ): GitCheckObservation => ({
      provider: 'github',
      attemptId,
      headSha,
      observedAtMs: at,
      completedAtMs: conclusion === null ? null : at,
      status: conclusion === null ? 'queued' : 'completed',
      conclusion,
    });
    const lookup = (headSha?: string, overrides = {}) =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) =>
          links.findRequestTaskKeys(
            scope,
            { organizationId, receiverId, binding, requestNumber: 215, ...overrides },
            headSha,
          ),
        ),
      );
    const record = (fact: Extract<VerifiedGitDelivery, { kind: 'actionable' }>) =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) => links.record(scope, identity, fact, 'CAD-485')),
      );
    const checks = (headSha: string) =>
      ({
        kind: 'actionable',
        trigger: 'pr_checks',
        requestNumber: 215,
        taskKeys: ['CAD-485'],
        closingTaskKeys: [],
        checks: { requestNumber: 215, headSha, attemptId: 10, completedAtMs: 120 },
      }) as const satisfies VerifiedGitDelivery;

    // A running suite arrives before the opening delivery creates the link.
    expect(await observe(suite(shaA, 10, 90, null))).toBe('recorded');
    expect(await record(opened)).toMatchObject({
      events: [
        { type: 'pull-request-opened', version: 1 },
        { type: 'link-updated', version: 2, changed: ['checks'] },
      ],
    });
    expect(await lookup(shaA)).toEqual(['CAD-485']);
    expect(await lookup(shaB)).toEqual([]);
    expect(await lookup(undefined, { binding: { ...binding, installationId: 42 } })).toEqual([]);
    await expect(
      record({ ...checks(shaA), checks: { ...checks(shaA).checks, requestNumber: 216 } }),
    ).rejects.toThrow('verified checks do not match');

    expect(await observe(suite(shaA, 10, 120, 'success'))).toBe('recorded');
    expect(await observe(suite(shaA, 10, 110, null))).toBe('ignored');
    await expect(
      runWithOrganizationContext(context, () =>
        runner.run(async (scope) => {
          await links.record(scope, identity, checks(shaA), 'CAD-485');
          throw new Error('roll back check and outbox');
        }),
      ),
    ).rejects.toThrow('roll back check and outbox');
    expect(await record(checks(shaA))).toMatchObject({
      events: [{ type: 'checks-completed', version: 3 }],
    });
    expect(await record(checks(shaA))).toMatchObject({ events: [] });

    // The suite of the next head is stored before GitHub reports the head change.
    await observe(suite(shaB, 11, 350, 'failure'));
    const head = { ...opened, trigger: 'pr_head' as const };
    expect(await record({ ...head, head: { sha: shaA, observedAtMs: 300 } })).toMatchObject({
      events: [],
    });
    expect(await record({ ...head, head: { sha: shaB, observedAtMs: 200 } })).toMatchObject({
      events: [],
    });
    expect(await lookup(shaA)).toEqual(['CAD-485']);
    expect(await record({ ...head, head: { sha: shaB, observedAtMs: 400 } })).toMatchObject({
      events: [
        { type: 'link-updated', version: 4, changed: ['headSha', 'checks', 'checksCompletedAt'] },
      ],
    });
    expect(await lookup(shaB)).toEqual(['CAD-485']);
    expect(await record(checks(shaA))).toMatchObject({ events: [] });
    await runWithOrganizationContext(context, () =>
      runner.run((scope) => links.purge(scope, organizationId, 'CAD-485')),
    );
    expect(await lookup()).toEqual([]);
    expect(await record(checks(shaB))).toBeNull();
  });

  it('stores lifecycle watermarks and the reconciliation mark of an equal-time tie', async () => {
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const T = Date.UTC(2026, 10, 8, 10, 41);
    const at = (state: 'open' | 'closed', observedAtMs: number) => ({
      state: { state, observedAtMs },
      members: { title: `CAD-486 ${state}` },
    });
    const opened = {
      ...request,
      requestNumber: 217,
      taskKeys: ['CAD-486'],
      request: at('open', T - 1_000),
    } as const;
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, opened);
    const record = (fact: Extract<VerifiedGitDelivery, { kind: 'actionable' }>) =>
      runWithOrganizationContext(context, () =>
        runner.run((scope) => links.record(scope, identity, fact, 'CAD-486')),
      );
    const marked = () =>
      runWithOrganizationContext(context, () =>
        runner.run(async (scope) => {
          const rows = await scope.client.query(
            `select reconciliation_pending_since is not null as pending, title
               from git_links where organization_id = $1 and task_key = 'CAD-486'`,
            [organizationId],
          );
          return rows.rows[0] as { readonly pending: boolean; readonly title: string } | undefined;
        }),
      );
    await record(opened);
    expect(
      await record({ ...opened, trigger: 'pr_closed', request: at('closed', T) }),
    ).toMatchObject({
      events: [{ type: 'pull-request-closed', version: 2 }],
      reconciliation: 'unchanged',
    });
    expect(
      await record({ ...opened, trigger: 'pr_reopened', request: at('open', T) }),
    ).toMatchObject({
      events: [{ type: 'pull-request-reopened', version: 3 }],
      reconciliation: 'marked',
    });
    expect(await marked()).toEqual({ pending: true, title: 'CAD-486 open' });
    expect(
      await record({ ...opened, trigger: 'pr_updated', request: at('open', T + 1_000) }),
    ).toMatchObject({ events: [], reconciliation: 'cleared' });
    expect(await marked()).toEqual({ pending: false, title: 'CAD-486 open' });
  });

  it('does not return a truncated request audience over the bounded admission limit', async () => {
    const context = {
      organizationId,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const fact = { ...request, requestNumber: 216, taskKeys: ['CAD-600'] } as const;
    const identity = gitLinkIdentity({ organizationId, receiverId, taskId, binding }, fact);
    await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        await links.record(scope, identity, fact, 'CAD-600');
        await scope.client.query(
          `insert into git_links
            (organization_id, receiver_id, provider, task_id, task_key, identity_hash, identity, status, version)
           select $1, $2, 'github', uuidv7(), 'CAD-' || n::text, identity_hash, identity, 'open', 1
             from git_links cross join generate_series(601, 620) as n
            where organization_id = $1 and receiver_id = $2 and task_key = 'CAD-600'`,
          [organizationId, receiverId],
        );
      }),
    );
    const results = await runWithOrganizationContext(context, () =>
      runner.run((scope) =>
        links.findRequestTaskKeys(scope, {
          organizationId,
          receiverId,
          binding,
          requestNumber: 216,
        }),
      ),
    );
    expect(results).toBeNull();
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
