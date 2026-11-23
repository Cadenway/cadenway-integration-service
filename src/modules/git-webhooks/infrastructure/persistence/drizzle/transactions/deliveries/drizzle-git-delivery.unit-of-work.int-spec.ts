import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DrizzleGitDeliveryTransaction } from './drizzle-git-delivery.unit-of-work.js';
import type { GitTaskAction } from '../../../../../application/ports/outbound/actions/dispatch/git-task-action.port.js';
import { decideGitCheckPrerequisites } from '../../../../../application/models/dispatch/git-check-prerequisites.model.js';
import { DispatchGitDelivery } from '../../../../../application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';
import { ManageGitWebhookBinding } from '../../../../../application/use-cases/commands/bindings/manage-git-webhook-binding/manage-git-webhook-binding.use-case.js';
import { DrizzleGitWebhookBindingUnitOfWork } from '../bindings/drizzle-git-webhook-binding.unit-of-work.js';
import type { GitDispatchJobsProducer } from '../../../../jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import { DrizzleGitDispatchUnitOfWork } from '../dispatch/drizzle-git-dispatch.unit-of-work.js';

const composeFile = fileURLToPath(
  new URL('../../../../../../../../compose.dev.yaml', import.meta.url),
);
const project = `cadenway-git-receipt-test-${String(process.pid)}`;
const organization = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganization = '01938f6e-0000-7000-8000-000000000002';
const receiver = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const otherReceiver = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const gitlabReceiver = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const actor = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);

function receiptId(row: unknown): string {
  if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') {
    throw new Error('Missing delivery ID.');
  }
  return row.id;
}

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

describe('Git delivery persistence', () => {
  let pool: pg.Pool | undefined;
  let runner: TenantTransactionRunner;

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
    for (const [tenant, id, provider] of [
      [organization, receiver, 'github'],
      [otherOrganization, otherReceiver, 'github'],
      [organization, gitlabReceiver, 'gitlab'],
    ]) {
      if (tenant === undefined || id === undefined) throw new Error('Missing test receiver.');
      await runWithOrganizationContext(
        { organizationId: tenant, actor: { type: 'user', id: actor }, role: null, scopes: [] },
        () =>
          runner.run(async (scope) => {
            await scope.client.query(
              'insert into git_webhook_receivers (organization_id, id, provider) values ($1, $2, $3)',
              [tenant, id, provider],
            );
          }),
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    compose('down', '--volumes', '--remove-orphans');
  });

  it('registers, rotates and revokes one binding without exposing it to another tenant', async () => {
    const bindingId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e21';
    const identity = { organizationId: organization, bindingId, provider: 'github' } as const;
    const registration = {
      ...identity,
      action: 'register',
      revision: 1,
      integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e22',
      spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e23',
      mappingAuthorUserId: actor,
      repositoryId: 111,
      installationId: 222,
    } as const;
    const bindings = new ManageGitWebhookBinding(new DrizzleGitWebhookBindingUnitOfWork(runner));
    expect(
      await Promise.all([bindings.execute(registration), bindings.execute(registration)]),
    ).toEqual([true, true]);
    expect(await bindings.execute({ ...registration, organizationId: otherOrganization })).toBe(
      false,
    );
    expect(await bindings.execute({ ...registration, spaceId: bindingId })).toBe(false);

    const rotate = { ...identity, action: 'rotate', revision: 1 } as const;
    expect(await Promise.all([bindings.execute(rotate), bindings.execute(rotate)])).toEqual([
      true,
      true,
    ]);
    expect(await bindings.execute({ ...identity, action: 'revoke', revision: 1 })).toBe(false);
    expect(await bindings.execute({ ...identity, action: 'revoke', revision: 2 })).toBe(true);
    expect(await bindings.execute({ ...identity, action: 'revoke', revision: 2 })).toBe(true);
    expect(await bindings.execute({ ...registration, revision: 2 })).toBe(false);
    expect(await bindings.execute({ ...rotate, revision: 2 })).toBe(false);
  });

  it('retains only the admitted GitHub delivery ID across concurrent body duplicates', async () => {
    const run = (tenant: string, deliveryId: string, bodyDigest: string) =>
      runWithOrganizationContext(
        { organizationId: tenant, actor: { type: 'user', id: actor }, role: null, scopes: [] },
        () =>
          runner.run(async (scope) => {
            const selectedReceiver = tenant === organization ? receiver : otherReceiver;
            await scope.client.query(
              'select id from git_webhook_receivers where organization_id = $1 and id = $2 for update',
              [tenant, selectedReceiver],
            );
            const delivery = new DrizzleGitDeliveryTransaction(
              scope,
              tenant,
              selectedReceiver,
              'github',
            );
            const prior = await delivery.checkDelivery(deliveryId, bodyDigest);
            return prior === 'new'
              ? delivery.admit({ deliveryId, digest: bodyDigest, work: null })
              : prior;
          }),
      );

    const outcomes = await Promise.all([
      run(organization, 'first', digest),
      run(organization, 'second', digest),
    ]);
    expect(outcomes.toSorted()).toEqual(['accepted', 'duplicate']);
    const admittedId = outcomes[0] === 'accepted' ? 'first' : 'second';
    expect(await run(organization, admittedId, otherDigest)).toBe('conflict');
    expect(await run(organization, 'third', digest)).toBe('duplicate');
    expect(await run(otherOrganization, 'first', digest)).toBe('accepted');
    const counts = await runWithOrganizationContext(
      { organizationId: organization, actor: { type: 'user', id: actor }, role: null, scopes: [] },
      () =>
        runner.run(async (scope) =>
          scope.client.query(
            'select (select count(*)::int from git_webhook_deliveries) as receipts, (select count(*)::int from git_webhook_delivery_ids) as ids',
          ),
        ),
    );
    expect(counts.rows).toEqual([{ receipts: 1, ids: 1 }]);
  });

  it('rolls back accepted work and matches the active repository under its tenant', async () => {
    const context = {
      organizationId: organization,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const repository = { provider: 'gitlab' as const, repositoryId: 123 };
    const integration = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e04';
    const space = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e05';
    await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        await scope.client.query(
          `insert into git_repository_mappings
          (organization_id, receiver_id, integration_id, provider, repository_id, space_id, mapping_author_user_id)
          values ($1, $2, $3, 'gitlab', 123, $4, $5)`,
          [organization, gitlabReceiver, integration, space, actor],
        );
      }),
    );

    const transaction = () =>
      runWithOrganizationContext(context, () =>
        runner.run(async (scope) => {
          const delivery = new DrizzleGitDeliveryTransaction(
            scope,
            organization,
            gitlabReceiver,
            'gitlab',
          );
          const mapping = await delivery.findMapping(repository);
          expect(mapping).toEqual({
            binding: repository,
            integrationId: integration,
            spaceId: space,
            mappingAuthorUserId: actor,
          });
          expect(await delivery.findMapping({ provider: 'gitlab', repositoryId: 124 })).toBeNull();
          if (mapping === null) throw new Error('Mapping fixture is missing.');
          expect(await delivery.checkDelivery('gitlab-delivery', digest)).toBe('new');
          const result = await delivery.admit({
            deliveryId: 'gitlab-delivery',
            digest,
            work: {
              mapping,
              fact: {
                kind: 'actionable',
                trigger: 'pr_open',
                requestNumber: 214,
                taskKeys: ['CAD-482'],
                closingTaskKeys: [],
              },
            },
          });
          expect(result).toBe('accepted');
          throw new Error('Roll back receipt and work.');
        }),
      );
    await expect(transaction()).rejects.toThrow('Roll back receipt and work.');
    await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        const delivery = new DrizzleGitDeliveryTransaction(
          scope,
          organization,
          gitlabReceiver,
          'gitlab',
        );
        expect(await delivery.checkDelivery('gitlab-delivery', digest)).toBe('new');
        expect(await delivery.admit({ deliveryId: 'gitlab-delivery', digest, work: null })).toBe(
          'accepted',
        );
        expect(await delivery.checkDelivery('gitlab-delivery', digest)).toBe('duplicate');
        expect(await delivery.checkDelivery('gitlab-delivery', otherDigest)).toBe('conflict');
        expect(await delivery.checkDelivery('GITLAB-DELIVERY', digest)).toBe('new');
      }),
    );
  });

  it('retains stable per-task commands and closes claims after mapping revocation', async () => {
    const context = {
      organizationId: organization,
      actor: { type: 'user' as const, id: actor },
      role: null,
      scopes: [],
    };
    const mapping = {
      binding: { provider: 'github' as const, repositoryId: 987, installationId: 654 },
      integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e06',
      spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e07',
      mappingAuthorUserId: actor,
    };
    const fact = {
      kind: 'actionable' as const,
      trigger: 'pr_open' as const,
      requestNumber: 214,
      taskKeys: ['CAD-482', 'CAD-483'],
      closingTaskKeys: [],
    };
    const deliveryId = await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        await scope.client.query(
          `insert into git_repository_mappings
          (organization_id, receiver_id, integration_id, provider, repository_id, installation_id, space_id, mapping_author_user_id)
          values ($1, $2, $3, 'github', 987, 654, $4, $5)`,
          [organization, receiver, mapping.integrationId, mapping.spaceId, actor],
        );
        const created = await scope.client.query(
          `insert into git_webhook_deliveries
          (organization_id, receiver_id, provider, receiver_revision, digest, work)
          values ($1, $2, 'github', 1, $3, $4::jsonb) returning id`,
          [organization, receiver, 'c'.repeat(64), JSON.stringify({ mapping, fact })],
        );
        return receiptId(created.rows[0]);
      }),
    );
    const dispatch = new DrizzleGitDispatchUnitOfWork(runner);
    const firstInput = { organizationId: organization, deliveryId, taskKey: 'CAD-482' };
    const [first, retry] = await Promise.all([
      dispatch.prepare(firstInput),
      dispatch.prepare(firstInput),
    ]);
    expect(first.status).toBe('ready');
    expect(retry.status).toBe('ready');
    if (first.status !== 'ready' || retry.status !== 'ready')
      throw new Error('Missing dispatch claim.');
    expect(first.claim.commandKey).toBe(retry.claim.commandKey);
    expect(await dispatch.prepare({ ...firstInput, taskKey: 'CAD-999' })).toEqual({
      status: 'closed',
    });
    expect(await dispatch.prepare({ ...firstInput, organizationId: otherOrganization })).toEqual({
      status: 'closed',
    });

    const second = await dispatch.prepare({ ...firstInput, taskKey: 'CAD-483' });
    if (second.status !== 'ready') throw new Error('Missing second dispatch claim.');
    const result = {
      disposition: 'applied' as const,
      taskId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e08',
      listId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e09',
      spaceId: mapping.spaceId,
    };
    expect(
      await dispatch.finish({
        organizationId: organization,
        deliveryId,
        claim: first.claim,
        result,
      }),
    ).toBe('completed');
    expect(
      await dispatch.finish({
        organizationId: organization,
        deliveryId,
        claim: retry.claim,
        result,
      }),
    ).toBe('completed');
    await runWithOrganizationContext(context, () =>
      runner.run(async (scope) => {
        await scope.client.query(
          'update git_repository_mappings set enabled = false where organization_id = $1 and receiver_id = $2 and repository_id = 987',
          [organization, receiver],
        );
      }),
    );
    expect(
      await dispatch.finish({
        organizationId: organization,
        deliveryId,
        claim: second.claim,
        result,
      }),
    ).toBe('closed');
    expect(await dispatch.prepare({ ...firstInput, taskKey: 'CAD-483' })).toEqual({
      status: 'closed',
    });
    const rows = await runWithOrganizationContext(context, () =>
      runner.run(async (scope) =>
        scope.client.query(
          'select task_key, status, task_id from git_dispatch_claims where organization_id = $1 and delivery_id = $2 order by task_key',
          [organization, deliveryId],
        ),
      ),
    );
    expect(rows.rows).toEqual([
      { task_key: 'CAD-482', status: 'completed', task_id: result.taskId },
      { task_key: 'CAD-483', status: 'closed', task_id: null },
    ]);
  });

  it('closes a check without Task effects when a head predecessor expires unresolved', async () => {
    const tenant = <T>(work: Parameters<typeof runner.run<T>>[0]): Promise<T> =>
      runWithOrganizationContext(
        {
          organizationId: organization,
          actor: { type: 'user', id: actor },
          role: null,
          scopes: [],
        },
        () => runner.run(work),
      );
    const mapping = {
      binding: { provider: 'github', repositoryId: 999, installationId: 654 },
      integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9f06',
      spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9f07',
      mappingAuthorUserId: actor,
    };
    const requestNumber = 216;
    const taskKey = 'CAD-489';
    const fact = { kind: 'actionable', requestNumber, taskKeys: [taskKey], closingTaskKeys: [] };
    const time = Date.now() - 61 * 60_000;
    const hex = time.toString(16).padStart(12, '0');
    const predecessor = `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000002`;
    const { deliveryId, livePredecessor } = await tenant(async ({ client }) => {
      await client.query(
        `insert into git_repository_mappings
          (organization_id, receiver_id, integration_id, provider, repository_id, installation_id,
           space_id, mapping_author_user_id)
          values ($1, $2, $3, 'github', 999, 654, $4, $5)`,
        [organization, receiver, mapping.integrationId, mapping.spaceId, actor],
      );
      await client.query(
        `insert into git_webhook_deliveries
           (organization_id, id, receiver_id, provider, receiver_revision, digest, work, created_at)
           values ($1, $2, $3, 'github', 1, $4, $5::jsonb, $6)`,
        [
          organization,
          predecessor,
          receiver,
          'd'.repeat(64),
          JSON.stringify({
            mapping,
            fact: {
              ...fact,
              trigger: 'pr_head',
              head: { sha: 'b'.repeat(40), observedAtMs: time },
            },
            recordLink: true,
          }),
          new Date(time),
        ],
      );
      const live = await client.query(
        `insert into git_webhook_deliveries
           (organization_id, receiver_id, provider, receiver_revision, digest, work)
           values ($1, $2, 'github', 1, $3, $4::jsonb) returning id`,
        [
          organization,
          receiver,
          'f'.repeat(64),
          JSON.stringify({ mapping, fact: { ...fact, trigger: 'pr_open' }, recordLink: true }),
        ],
      );
      const liveId = receiptId(live.rows[0]);
      const result = await client.query(
        `insert into git_webhook_deliveries
           (organization_id, receiver_id, provider, receiver_revision, digest, work)
           values ($1, $2, 'github', 1, $3, $4::jsonb) returning id`,
        [
          organization,
          receiver,
          'e'.repeat(64),
          JSON.stringify({
            mapping,
            fact: {
              ...fact,
              trigger: 'pr_checks',
              checks: {
                requestNumber,
                headSha: 'a'.repeat(40),
                attemptId: 1,
                completedAtMs: Date.now(),
              },
            },
            recordLink: true,
            prerequisiteIds: [predecessor, liveId],
          }),
        ],
      );
      return { deliveryId: receiptId(result.rows[0]), livePredecessor: liveId };
    });

    const apply = vi.fn<GitTaskAction['apply']>();
    const enqueue = vi.fn<GitDispatchJobsProducer['enqueue']>().mockResolvedValue(undefined);
    const work = new DrizzleGitDispatchUnitOfWork(runner, undefined, {
      decide: decideGitCheckPrerequisites,
      jobs: { enqueue },
    });
    const dispatch = new DispatchGitDelivery(work, { apply });
    const input = { organizationId: organization, deliveryId, taskKey };
    const databaseClock = await tenant(({ client }) =>
      client.query('select clock_timestamp() as now'),
    );
    const row = databaseClock.rows[0];
    if (typeof row !== 'object' || row === null || !('now' in row) || !(row.now instanceof Date)) {
      throw new Error('Missing PostgreSQL time.');
    }
    const now = row.now;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now.getTime() - 60_000);
    try {
      expect(await dispatch.execute(input)).toEqual({ status: 'deferred' });
      const scheduled = enqueue.mock.calls[0]?.[4];
      expect(scheduled?.getTime()).toBeGreaterThan(now.getTime());
      expect(apply).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
    await tenant(({ client }) =>
      client.query(
        `insert into git_dispatch_claims (organization_id, delivery_id, task_key, status)
         values ($1, $2, $3, 'closed')`,
        [organization, livePredecessor, taskKey],
      ),
    );
    expect(await dispatch.execute(input)).toEqual({ status: 'closed' });
    expect(await dispatch.execute(input)).toEqual({ status: 'closed' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    const claim = await tenant(({ client }) =>
      client.query(
        `select status, task_id from git_dispatch_claims
          where organization_id = $1 and delivery_id = $2 and task_key = $3`,
        [organization, deliveryId, taskKey],
      ),
    );
    expect(claim.rows).toEqual([{ status: 'closed', task_id: null }]);
  });
});
