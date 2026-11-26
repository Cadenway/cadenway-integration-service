import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import {
  GIT_LINK_UPDATED_V1,
  GIT_PR_MERGED_V1,
} from '@cadenway/contracts/events/integration-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import {
  type DatabaseSchema,
  SystemTransactionRunner,
  TenantTransactionRunner,
} from '@cadenway/nest-common/database';
import { provisionJobs } from '@cadenway/nest-jobs/provisioning';
import { JobProducer, JobsRuntimeModule } from '@cadenway/nest-jobs/runtime';
import {
  DEFAULT_EVENT_SUBJECT_PREFIX,
  DEFAULT_EVENTS_STREAM,
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
} from '@cadenway/nest-messaging';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { Test, type TestingModule } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GIT_HEAD_CHECKS_QUEUE,
  GIT_LINK_DISPATCH_V2_QUEUE,
  GIT_MERGE_INTENT_QUEUE,
} from '../../../../../../../config/job-queues.js';
import { GitHeadChecksJobsProducer } from '../../../../jobs/pg-boss/checks/git-head-checks.adapter.js';
import { GitDispatchJobsProducer } from '../../../../jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import { DrizzleGitHeadChecksUnitOfWork } from '../checks/drizzle-git-head-checks.unit-of-work.js';
import type { GitDispatchClaim } from '../../../../../application/models/dispatch/git-dispatch-claim.model.js';
import { GitMergeIntentJobsProducer } from '../../../../jobs/pg-boss/merges/git-merge-intent.adapter.js';
import { GitLinkChangedOutbox } from '../../../../messaging/outbox/links/git-link-changed-outbox.adapter.js';
import { DrizzleGitLinkRepository } from '../../repositories/links/drizzle-git-link.repository.js';
import { DrizzleTaskGitLinkReader } from '../../repositories/links/drizzle-task-git-link-reader.repository.js';
import { DrizzleGitMergeIntentRepository } from '../../repositories/merges/drizzle-git-merge-intent.repository.js';
import { DrizzleGitLinkMaintenanceUnitOfWork } from '../maintenance/drizzle-git-link-maintenance.unit-of-work.js';
import { DrizzleGitMergeIntentUnitOfWork } from '../merges/drizzle-git-merge-intent.unit-of-work.js';
import { DrizzleGitLinkSettlement } from './drizzle-git-link-settlement.unit-of-work.js';

const project = `cadenway-integration-git-settlement-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const receiverId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const taskId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const mapping = {
  binding: { provider: 'github', repositoryId: 734912058, installationId: 41 },
  integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e04',
  spaceId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  mappingAuthorUserId: '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32',
} as const;
const placement = {
  disposition: 'no_op',
  taskId,
  listId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12',
  spaceId: mapping.spaceId,
} as const;
const T = Date.UTC(2026, 10, 8, 10, 41);

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

function inOrganization<T>(work: () => Promise<T>, organization = organizationId): Promise<T> {
  return runWithOrganizationContext(
    {
      organizationId: organization,
      actor: { type: 'system', id: 'integration-service' },
      role: null,
      scopes: [],
    },
    work,
  );
}

let sequence = 0;

/** A UUIDv7 created at `atMs`, as PostgreSQL assigns receipts and claims. */
function uuidv7(atMs = Date.now()): string {
  const time = atMs.toString(16).padStart(12, '0');
  const random = randomBytes(10).toString('hex');
  const variant = (8 + (Number.parseInt(random.slice(3, 4), 16) % 4)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

/** A dispatch claim of one admitted delivery for CAD-482, as the dispatch unit of work builds it. */
function claim(
  taskKey: string,
  requestNumber: number,
  fact: Partial<GitDispatchClaim['fact']> & Pick<GitDispatchClaim['fact'], 'trigger'>,
  mergeIntent = true,
  claimedAtMs = Date.now(),
): GitDispatchClaim {
  sequence += 1;
  return {
    organizationId,
    deliveryId: uuidv7(claimedAtMs),
    admissionSequence: sequence,
    commandKey: uuidv7(claimedAtMs),
    taskKey,
    receiverRevision: 1,
    mapping,
    fact: {
      kind: 'actionable',
      requestNumber,
      taskKeys: [taskKey],
      closingTaskKeys: [taskKey],
      ...fact,
    } as GitDispatchClaim['fact'],
    mergeIntent,
  };
}

describe('Git link settlement, merge intents and the link read', () => {
  let pool: pg.Pool | undefined;
  let runtime: TestingModule | undefined;
  let runner: TenantTransactionRunner<DatabaseSchema>;
  let settlement: DrizzleGitLinkSettlement;
  let failingSettlement: DrizzleGitLinkSettlement;
  let intents: DrizzleGitMergeIntentUnitOfWork;
  let maintenance: DrizzleGitLinkMaintenanceUnitOfWork;
  let reader: DrizzleTaskGitLinkReader;
  let headChecks: DrizzleGitHeadChecksUnitOfWork;

  const settle = (current: GitDispatchClaim, using = settlement) =>
    inOrganization(() =>
      runner.run((scope) => using.record(scope, current, receiverId, placement)),
    );
  const query = <R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> =>
    inOrganization(() =>
      runner.run(async ({ client }) => (await client.query(text, values)).rows as R[]),
    );

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
        queues: [GIT_MERGE_INTENT_QUEUE, GIT_HEAD_CHECKS_QUEUE, GIT_LINK_DISPATCH_V2_QUEUE],
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
          queues: [GIT_MERGE_INTENT_QUEUE, GIT_HEAD_CHECKS_QUEUE, GIT_LINK_DISPATCH_V2_QUEUE],
          capabilities: ['producer'],
          poolSize: 2,
        }),
      ],
    }).compile();
    await runtime.init();
    const jobs = new GitMergeIntentJobsProducer(runtime.get(JobProducer));
    const writer = new OutboxWriter({
      restrictedEvents: [],
      eventSubjectPrefix: DEFAULT_EVENT_SUBJECT_PREFIX,
      eventsStream: DEFAULT_EVENTS_STREAM,
      restrictedSubjectPrefix: DEFAULT_RESTRICTED_SUBJECT_PREFIX,
      restrictedStream: DEFAULT_RESTRICTED_STREAM,
    } as unknown as ConstructorParameters<typeof OutboxWriter>[0]);
    const links = new DrizzleGitLinkRepository();
    const merges = new DrizzleGitMergeIntentRepository();
    settlement = new DrizzleGitLinkSettlement(
      links,
      new GitLinkChangedOutbox(writer),
      merges,
      jobs,
    );
    failingSettlement = new DrizzleGitLinkSettlement(
      links,
      { append: () => Promise.reject(new Error('Outbox unavailable.')) },
      merges,
      jobs,
    );
    intents = new DrizzleGitMergeIntentUnitOfWork(runner, jobs);
    maintenance = new DrizzleGitLinkMaintenanceUnitOfWork(
      new SystemTransactionRunner(pool),
      runner,
      jobs,
    );
    reader = new DrizzleTaskGitLinkReader(runner);
    headChecks = new DrizzleGitHeadChecksUnitOfWork(
      runner,
      links,
      new GitDispatchJobsProducer(runtime.get(JobProducer)),
      new GitHeadChecksJobsProducer(runtime.get(JobProducer)),
    );
    for (const tenant of [organizationId]) {
      await inOrganization(
        () =>
          runner.run(async ({ client }) => {
            await client.query(
              "insert into git_webhook_receivers (organization_id, id, provider) values ($1, $2, 'github')",
              [tenant, receiverId],
            );
          }),
        tenant,
      );
    }
    await query(
      `insert into git_repository_mappings
         (organization_id, receiver_id, integration_id, provider, repository_id, installation_id,
          space_id, mapping_author_user_id)
       values ($1, $2, $3, 'github', $4, $5, $6, $7)`,
      [
        organizationId,
        receiverId,
        mapping.integrationId,
        mapping.binding.repositoryId,
        mapping.binding.installationId,
        mapping.spaceId,
        mapping.mappingAuthorUserId,
      ],
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

  const facts = (taskKey: string) =>
    query<{ readonly name: string; readonly version: number; readonly changed: string[] }>(
      `select event_name as name, (payload ->> 'version')::int as version,
              array(select jsonb_array_elements_text(payload -> 'changed')) as changed
         from outbox_events
        where payload ->> 'taskKey' = $1
        order by (payload ->> 'version')::int`,
      [taskKey],
    );
  const intentOf = (taskKey: string) =>
    query<{
      readonly link_id: string;
      readonly delivery_id: string;
      readonly command_key: string;
      readonly status: string;
      readonly disposition: string | null;
      readonly reason: string | null;
      readonly attempts: number;
    }>(
      `select link_id, delivery_id, command_key, status, disposition, reason, attempts::int as attempts
         from git_merge_intents where task_key = $1`,
      [taskKey],
    );
  const intentJobs = (linkId: string) =>
    query<{ readonly start_after: Date }>(
      `select start_after from pgboss.job
        where name = $1 and data -> 'payload' ->> 'linkId' = $2
        order by start_after`,
      [GIT_MERGE_INTENT_QUEUE.name, linkId],
    );

  it('records one merge intent and one first job for concurrent merge deliveries', async () => {
    await settle(claim('CAD-482', 214, { trigger: 'pr_open', closingTaskKeys: [] }));
    const first = claim('CAD-482', 214, { trigger: 'pr_merged' });
    const second = claim('CAD-482', 214, { trigger: 'pr_merged' });
    await Promise.all([settle(first), settle(second)]);

    expect(await facts('CAD-482')).toEqual([
      expect.objectContaining({ version: 1 }),
      { name: GIT_PR_MERGED_V1, version: 2, changed: ['state'] },
    ]);
    const intents = await intentOf('CAD-482');
    expect(intents).toHaveLength(1);
    const intent = intents[0];
    const winner = intent?.delivery_id === first.deliveryId ? first : second;
    expect(intent).toMatchObject({
      command_key: winner.commandKey,
      status: 'pending',
      attempts: 0,
    });
    expect(await intentJobs(intent?.link_id ?? '')).toHaveLength(1);
  });

  it('submits the merge once when it arrives after a realignment already published it', async () => {
    await settle(claim('CAD-483', 215, { trigger: 'pr_open', closingTaskKeys: [] }));
    await settle(
      claim('CAD-483', 215, {
        trigger: 'pr_updated',
        closingTaskKeys: [],
        request: { state: { state: 'merged', observedAtMs: T }, members: {} },
      }),
    );
    await settle(
      claim('CAD-483', 215, {
        trigger: 'pr_merged',
        request: { state: { state: 'merged', observedAtMs: T }, members: { additions: 96 } },
      }),
    );
    expect(await facts('CAD-483')).toEqual([
      expect.objectContaining({ version: 1 }),
      { name: GIT_PR_MERGED_V1, version: 2, changed: ['state'] },
      { name: GIT_LINK_UPDATED_V1, version: 3, changed: ['additions'] },
    ]);
    expect(await intentOf('CAD-483')).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('records the merge status a receipt from an earlier release sent with its dispatch', async () => {
    await settle(claim('CAD-491', 222, { trigger: 'pr_merged' }, false));
    const [intent] = await intentOf('CAD-491');
    expect(intent).toMatchObject({ status: 'handled', disposition: 'no_op', reason: null });
    expect(await intentJobs(intent?.link_id ?? '')).toEqual([]);
  });

  it('records a merge without a closing verb as handled with nothing to submit', async () => {
    await settle(claim('CAD-484', 216, { trigger: 'pr_merged', closingTaskKeys: [] }));
    const [intent] = await intentOf('CAD-484');
    expect(intent).toMatchObject({ status: 'handled', reason: 'no-status-intent' });
    expect(await intentJobs(intent?.link_id ?? '')).toEqual([]);
  });

  it('rolls back the link change and its merge intent with a failed outbox write', async () => {
    await expect(
      settle(claim('CAD-485', 217, { trigger: 'pr_merged' }), failingSettlement),
    ).rejects.toThrow('Outbox unavailable.');
    expect(await query('select id from git_links where task_key = $1', ['CAD-485'])).toEqual([]);
    expect(await intentOf('CAD-485')).toEqual([]);
  });

  it('retries a timed-out submission under the same key, then records Task confirmation', async () => {
    await settle(claim('CAD-486', 218, { trigger: 'pr_merged' }));
    const [created] = await intentOf('CAD-486');
    const linkId = created?.link_id ?? '';
    const input = { organizationId, linkId };

    const first = await intents.prepare(input);
    expect(first).toMatchObject({
      status: 'ready',
      command: { attempt: 1, commandKey: created?.command_key, taskKey: 'CAD-486', status: 'done' },
    });
    await expect(
      intents.settle({ ...input, attempt: 1, outcome: { kind: 'failed' } }),
    ).resolves.toBe('retrying');
    const jobs = await intentJobs(linkId);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.start_after.getTime()).toBeGreaterThan(Date.now() + 30_000);

    const second = await intents.prepare(input);
    expect(second).toMatchObject({
      status: 'ready',
      command: { attempt: 2, commandKey: created?.command_key },
    });
    await expect(
      intents.settle({
        ...input,
        attempt: 1,
        outcome: { kind: 'confirmed', disposition: 'applied' },
      }),
    ).resolves.toBe('superseded');
    await expect(
      intents.settle({
        ...input,
        attempt: 2,
        outcome: { kind: 'confirmed', disposition: 'no_op' },
      }),
    ).resolves.toBe('handled');
    expect(await intentOf('CAD-486')).toEqual([
      expect.objectContaining({ status: 'handled', disposition: 'no_op', attempts: 2 }),
    ]);
    await expect(intents.prepare(input)).resolves.toEqual({ status: 'settled' });
  });

  it('records a definitive refusal as handled with its reason', async () => {
    await settle(claim('CAD-487', 219, { trigger: 'pr_merged' }));
    const [created] = await intentOf('CAD-487');
    const input = { organizationId, linkId: created?.link_id ?? '' };
    await intents.prepare(input);
    await expect(
      intents.settle({
        ...input,
        attempt: 1,
        outcome: { kind: 'refused', reason: 'task.trashed' },
      }),
    ).resolves.toBe('handled');
    expect(await intentOf('CAD-487')).toEqual([
      expect.objectContaining({ status: 'handled', reason: 'task.trashed', disposition: null }),
    ]);
  });

  it('keeps an intent unconfirmed past the receipt window pending and reports it once', async () => {
    await settle(claim('CAD-488', 220, { trigger: 'pr_merged' }));
    const [created] = await intentOf('CAD-488');
    const input = { organizationId, linkId: created?.link_id ?? '' };
    await query(
      `update git_merge_intents set window_started_at = now() - interval '25 hours' where link_id = $1`,
      [input.linkId],
    );
    await expect(intents.prepare(input)).resolves.toEqual({ status: 'expired' });
    const reported = await maintenance.reportUnconfirmedMergeIntents(100);
    expect(reported).toContainEqual({ organizationId, gitLinkId: input.linkId });
    expect(await maintenance.reportUnconfirmedMergeIntents(100)).not.toContainEqual({
      organizationId,
      gitLinkId: input.linkId,
    });
    expect(await intentOf('CAD-488')).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('prunes old observations of heads no link uses and reports marked links', async () => {
    const current = 'c'.repeat(40);
    const orphan = 'd'.repeat(40);
    await settle(
      claim('CAD-489', 221, {
        trigger: 'pr_open',
        closingTaskKeys: [],
        head: { sha: current, observedAtMs: T },
      }),
    );
    for (const [sha, repositoryId] of [
      [current, mapping.binding.repositoryId],
      [orphan, mapping.binding.repositoryId],
      // The same head in another repository of the receiver is not that link's head.
      [current, mapping.binding.repositoryId + 1],
    ] as const) {
      await query(
        `insert into git_check_observations
           (organization_id, receiver_id, provider, repository_id, head_sha, attempt_id, status,
            conclusion, observed_at_ms, completed_at_ms, updated_at)
         values ($1, $2, 'github', $3, $4, 1, 'completed', 'success', $5, $5, now() - interval '8 days')`,
        [organizationId, receiverId, repositoryId, sha, T],
      );
    }
    await query(
      `update git_links set reconciliation_pending_since = now() where task_key = 'CAD-489'`,
    );
    await expect(maintenance.pruneCheckObservations(1_000)).resolves.toBe(2);
    expect(
      await query(
        'select head_sha, repository_id::int as repository_id from git_check_observations',
      ),
    ).toEqual([{ head_sha: current, repository_id: mapping.binding.repositoryId }]);
    const marked = await maintenance.reportReconciliationPending(100);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.organizationId).toBe(organizationId);
    // Each mark is reported once; a merged link is final and is not reported.
    expect(await maintenance.reportReconciliationPending(100)).toEqual([]);
    await settle(claim('CAD-494', 404, { trigger: 'pr_merged', closingTaskKeys: [] }));
    await query(
      `update git_links set reconciliation_pending_since = now() where task_key = 'CAD-494'`,
    );
    expect(await maintenance.reportReconciliationPending(100)).toEqual([]);
  });

  it('starts the receipt window when the dispatch claim was created', async () => {
    await settle(
      claim('CAD-495', 405, { trigger: 'pr_merged' }, true, Date.now() - 25 * 3_600_000),
    );
    const [created] = await intentOf('CAD-495');
    await expect(
      intents.prepare({ organizationId, linkId: created?.link_id ?? '' }),
    ).resolves.toEqual({ status: 'expired' });
  });

  it.each([
    ['before its attempt was claimed', false],
    ['after its attempt was claimed', true],
  ])('recovers a pending intent whose job the queue exhausted %s', async (_moment, claimed) => {
    const taskKey = claimed ? 'CAD-496' : 'CAD-499';
    await settle(claim(taskKey, claimed ? 406 : 407, { trigger: 'pr_merged' }));
    const [created] = await intentOf(taskKey);
    const linkId = created?.link_id ?? '';
    if (claimed) await intents.prepare({ organizationId, linkId });
    // The queue gave up on the job and retains its failed row under its occurrence key.
    await query(
      `update pgboss.job set state = 'failed' where name = $1 and data -> 'payload' ->> 'linkId' = $2`,
      [GIT_MERGE_INTENT_QUEUE.name, linkId],
    );
    const recover = async (): Promise<void> => {
      await query(
        `update git_merge_intents set updated_at = now() - interval '3 hours' where link_id = $1`,
        [linkId],
      );
      await maintenance.resumePendingMergeIntents(100);
    };
    await recover();
    const runnable = () =>
      query<{ readonly count: number }>(
        `select count(*)::int as count from pgboss.job
            where name = $1 and data -> 'payload' ->> 'linkId' = $2 and state = 'created'`,
        [GIT_MERGE_INTENT_QUEUE.name, linkId],
      );
    expect(await runnable()).toEqual([{ count: 1 }]);
    const recorded = () =>
      query(
        'select recoveries::int as recoveries, command_key from git_merge_intents where link_id = $1',
        [linkId],
      );
    expect(await recorded()).toEqual([{ recoveries: 1, command_key: created?.command_key }]);
    // A pass right after finds the intent touched and queues nothing more.
    await maintenance.resumePendingMergeIntents(100);
    expect(await runnable()).toEqual([{ count: 1 }]);
    // A later exhaustion gets a further recovery of its own.
    await query(
      `update pgboss.job set state = 'failed' where name = $1 and data -> 'payload' ->> 'linkId' = $2`,
      [GIT_MERGE_INTENT_QUEUE.name, linkId],
    );
    await recover();
    expect(await runnable()).toEqual([{ count: 1 }]);
    expect(await recorded()).toEqual([{ recoveries: 2, command_key: created?.command_key }]);
  });

  it('refreshes the links of a head that a check suite names no request for', async () => {
    const head = 'f'.repeat(40);
    await settle(
      claim('CAD-492', 401, {
        trigger: 'pr_open',
        closingTaskKeys: [],
        head: { sha: head, observedAtMs: T },
      }),
    );
    await settle(
      claim('CAD-492', 402, {
        trigger: 'pr_open',
        closingTaskKeys: [],
        head: { sha: 'e'.repeat(40), observedAtMs: T },
      }),
    );
    await query(
      `insert into git_check_observations
         (organization_id, receiver_id, provider, repository_id, head_sha, attempt_id, status,
          conclusion, observed_at_ms, completed_at_ms)
       values ($1, $2, 'github', $3, $4, 9, 'completed', 'success', $5, $5)`,
      [organizationId, receiverId, mapping.binding.repositoryId, head, T + 1_000],
    );
    await settle(
      claim('CAD-492', 0, {
        trigger: 'head_checks',
        headSha: head,
        targets: [
          { taskKey: 'CAD-492', requestNumber: 401 },
          { taskKey: 'CAD-492', requestNumber: 402 },
        ],
        checks: { headSha: head, attemptId: 9, completedAtMs: T + 1_000, observed: true },
        closingTaskKeys: [],
      }),
    );
    // Only the link whose current head is the suite's head changes.
    expect(
      await query(
        `select (identity ->> 'requestNumber')::int as number, checks, version::int as version
           from git_links where task_key = 'CAD-492' order by 1`,
      ),
    ).toEqual([
      { number: 401, checks: { state: 'passed', total: 1, failed: 0 }, version: 2 },
      { number: 402, checks: null, version: 1 },
    ]);
    expect((await facts('CAD-492')).map(({ name }) => name)).toContain('git.checks-completed.v1');
  });

  it('keeps same-second updates in admission order when they settle in reverse', async () => {
    await settle(claim('CAD-493', 403, { trigger: 'pr_open', closingTaskKeys: [] }));
    const update = (title: string) =>
      claim('CAD-493', 403, {
        trigger: 'pr_updated',
        closingTaskKeys: [],
        request: { state: { state: 'open', observedAtMs: T }, members: { title } },
      });
    const admittedFirst = update('Admitted first');
    const admittedSecond = update('Admitted second');
    // The Task call of the later admission returned first.
    await settle(admittedSecond);
    await settle(admittedFirst);
    expect(
      await query('select title, version::int as version from git_links where task_key = $1', [
        'CAD-493',
      ]),
    ).toEqual([{ title: 'Admitted second', version: 2 }]);
  });

  it('refreshes every link on a head in resumable pages, apart from the named request', async () => {
    const head = '9'.repeat(40);
    // 25 links of 25 tasks on one head, and the named request's link.
    for (let index = 0; index < 26; index += 1) {
      await settle(
        claim(`CAD-${String(600 + index)}`, 500 + index, {
          trigger: 'pr_open',
          closingTaskKeys: [],
          head: { sha: head, observedAtMs: T },
        }),
      );
    }
    const page = {
      organizationId,
      receiverId,
      binding: mapping.binding,
      headSha: head,
      attemptId: 77,
      observedAtMs: T,
      source: 'f'.repeat(64),
      page: 0,
      excludeRequestNumber: 525,
      after: null,
    };
    await expect(headChecks.refresh(page, 20)).resolves.toEqual({
      status: 'refreshed',
      links: 20,
      more: true,
    });
    const next = await query<{ readonly data: { readonly payload: typeof page } }>(
      'select data from pgboss.job where name = $1',
      [GIT_HEAD_CHECKS_QUEUE.name],
    );
    expect(next).toHaveLength(1);
    const second = { ...next[0]?.data.payload, organizationId } as typeof page;
    expect(second).toMatchObject({ page: 1, after: { taskKey: 'CAD-619' } });
    await expect(headChecks.refresh(second, 20)).resolves.toEqual({
      status: 'refreshed',
      links: 5,
      more: false,
    });
    // A page that runs again records nothing more.
    await headChecks.refresh(page, 20);
    const receipts = await query<{ readonly targets: number }>(
      `select jsonb_array_length(work -> 'fact' -> 'targets')::int as targets
         from git_webhook_deliveries where work -> 'fact' ->> 'trigger' = 'head_checks'
          and work -> 'fact' ->> 'headSha' = $1 order by created_at`,
      [head],
    );
    expect(receipts).toEqual([{ targets: 20 }, { targets: 5 }]);
    const dispatched = await query<{ readonly count: number }>(
      `select count(*)::int as count from pgboss.job
        where name = $1 and data -> 'payload' ->> 'taskKey' like 'CAD-6%'`,
      [GIT_LINK_DISPATCH_V2_QUEUE.name],
    );
    expect(dispatched).toEqual([{ count: 25 }]);
    const named = await query(
      `select 1 from git_webhook_deliveries
        where work -> 'fact' ->> 'trigger' = 'head_checks'
          and work -> 'fact' -> 'targets' @> '[{"taskKey": "CAD-625"}]'`,
    );
    expect(named).toEqual([]);
  });

  it('pages a task links newest first within the organization and hides a purged task', async () => {
    for (const number of [301, 302, 303]) {
      await settle(
        claim('CAD-490', number, {
          trigger: 'pr_open',
          closingTaskKeys: [],
          request: {
            state: { state: 'open', observedAtMs: T },
            members: { title: `Request ${String(number)}`, draft: false },
          },
          linkSources: { 'CAD-490': 'title' },
        }),
      );
    }
    const read = (
      after: { readonly createdAt: string; readonly id: string } | null,
      organization = organizationId,
    ) =>
      inOrganization(
        () =>
          reader.listTaskLinks({
            organizationId: organization,
            taskKey: 'CAD-490',
            after,
            limit: 2,
          }),
        organization,
      );
    const first = await read(null);
    expect(first.map((link) => link.number)).toEqual([303, 302]);
    expect(first[0]).toMatchObject({
      taskKey: 'CAD-490',
      provider: 'github',
      kind: 'pull-request',
      state: 'open',
      providerRepositoryId: mapping.binding.repositoryId,
      branch: null,
      headSha: null,
      checksCompletedAt: null,
      version: 1,
      title: 'Request 303',
      draft: false,
      linkSource: 'title',
    });
    expect(first[0]).not.toHaveProperty('checks');
    const last = first.at(-1);
    if (last === undefined) throw new Error('Expected a first page.');
    const second = await read({ createdAt: last.createdAt, id: last.id });
    expect(second.map((link) => link.number)).toEqual([301]);
    expect(await read(null, otherOrganizationId)).toEqual([]);
    await query(`insert into git_purged_tasks (organization_id, task_key) values ($1, 'CAD-490')`, [
      organizationId,
    ]);
    expect(await read(null)).toEqual([]);
  });
});
