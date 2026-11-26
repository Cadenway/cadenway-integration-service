import {
  InternalHttpClient,
  InternalTokenSigner,
  InternalTokenVerifier,
  runWithOrganizationContext,
} from '@cadenway/nest-common';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';

import type { GitDispatchClaim } from '../../../application/models/dispatch/git-dispatch-claim.model.js';
import { GitTaskHttpAdapter } from './git-task-http.adapter.js';

const organizationId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const spaceId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const integrationId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const mappingAuthorUserId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e04';
const claim: GitDispatchClaim = {
  organizationId,
  deliveryId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e08',
  admissionSequence: 1,
  commandKey: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e05',
  taskKey: 'CAD-482',
  receiverRevision: 1,
  mapping: {
    binding: { provider: 'github', repositoryId: 12, installationId: 34 },
    integrationId,
    mappingAuthorUserId,
    spaceId,
  },
  fact: {
    kind: 'actionable',
    trigger: 'pr_open',
    requestNumber: 214,
    taskKeys: ['CAD-482'],
    closingTaskKeys: [],
  },
  mergeIntent: true,
};

const receipt = {
  disposition: 'no_op',
  taskId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e06',
  listId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e07',
  spaceId,
} as const;

interface TaskRequest {
  // #region Properties
  /** Recorded request line, headers and body. */
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  // #endregion
}

interface TaskResponse {
  // #region Properties
  /** HTTP response sent by the test server. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  // #endregion
}

const authorized: TaskResponse = {
  status: 200,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  },
  body: JSON.stringify(receipt),
};
const replayed: TaskResponse = {
  ...authorized,
  headers: { ...authorized.headers, 'Idempotent-Replayed': 'true' },
  body: JSON.stringify({ ...receipt, disposition: 'applied' }),
};

function taskProblem(status: number, code: string): TaskResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title: 'Task command error', status, code }),
  };
}

async function withTaskServer(
  signer: InternalTokenSigner,
  reply: (attempt: number) => TaskResponse,
  verify: (adapter: GitTaskHttpAdapter, calls: readonly TaskRequest[]) => Promise<void>,
): Promise<void> {
  const calls: TaskRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => {
      body += part;
    });
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      const answer = reply(calls.length);
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Task test server did not bind.');
    const http = new InternalHttpClient({
      service: 'task-service',
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      signer,
    });
    await verify(new GitTaskHttpAdapter(http), calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

describe('GitTaskHttpAdapter', () => {
  let signer: InternalTokenSigner;
  let verifier: InternalTokenVerifier;

  beforeAll(async () => {
    const issuer = 'integration-service';
    const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    if (x === undefined || d === undefined) throw new Error('Could not generate test signing key.');
    const publicJwk = { kid: 'integration-task-test', kty: 'OKP', crv: 'Ed25519', x } as const;
    signer = await InternalTokenSigner.create({ issuer, privateJwk: { ...publicJwk, d } });
    verifier = await InternalTokenVerifier.create({
      audience: 'task-service',
      trustedIssuers: { [issuer]: [publicJwk] },
    });
  });

  it('sends the generated command with a stable key and the durable Git principal', async () => {
    await withTaskServer(
      signer,
      () => authorized,
      async (adapter, calls) => {
        const result = await runWithOrganizationContext(
          {
            organizationId: receipt.listId,
            actor: { type: 'user', id: mappingAuthorUserId },
            role: 'admin',
            scopes: ['tasks:write'],
          },
          () => adapter.apply(claim, 'review'),
        );

        expect(result).toEqual(receipt);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          method: 'POST',
          url: '/internal/v1/tasks/CAD-482/git-status-actions',
          headers: { 'idempotency-key': claim.commandKey, 'content-type': 'application/json' },
        });
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
          provider: 'github',
          spaceId,
          mappingAuthorUserId,
          status: 'review',
        });
        const token = calls[0]?.headers.authorization?.replace(/^Bearer /u, '') ?? '';
        await expect(verifier.verify(token)).resolves.toMatchObject({
          issuer: 'integration-service',
          audience: 'task-service',
          actor: { type: 'git', id: integrationId },
          organizationId,
          role: null,
          scopes: [],
        });
      },
    );
  });

  it('maps only the contracted Task target problem to unavailable', async () => {
    await withTaskServer(
      signer,
      () => taskProblem(404, 'task.not-found'),
      async (adapter) => {
        await expect(adapter.apply(claim, 'done')).resolves.toEqual({ disposition: 'unavailable' });
      },
    );
    await withTaskServer(
      signer,
      () => taskProblem(404, 'http.not-found'),
      async (adapter) => {
        await expect(adapter.apply(claim, 'done')).rejects.toMatchObject({
          problem: { status: 404, code: 'http.not-found' },
        });
      },
    );
  });

  it('keeps the original disposition and uses the new list of a task moved within its space', async () => {
    const movedReceipt = { ...receipt, listId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e08' };
    await withTaskServer(
      signer,
      (attempt) =>
        attempt === 1 ? replayed : { ...authorized, body: JSON.stringify(movedReceipt) },
      async (adapter, calls) => {
        await expect(adapter.apply(claim, 'review')).resolves.toEqual({
          ...movedReceipt,
          disposition: 'applied',
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]?.headers['idempotency-key']).toBe(claim.commandKey);
        expect(calls[1]?.headers['idempotency-key']).not.toBe(claim.commandKey);
        expect(calls[1]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
        expect(calls[1]?.url).toBe(calls[0]?.url);
        expect(JSON.parse(calls[1]?.body ?? '')).toEqual({
          provider: 'github',
          spaceId,
          mappingAuthorUserId,
          status: null,
        });
        const token = calls[1]?.headers.authorization?.replace(/^Bearer /u, '') ?? '';
        await expect(verifier.verify(token)).resolves.toMatchObject({
          issuer: 'integration-service',
          audience: 'task-service',
          actor: { type: 'git', id: integrationId },
          organizationId,
        });
      },
    );
  });

  it('closes the target if the mapping author cannot edit the currently placed task', async () => {
    await withTaskServer(
      signer,
      (attempt) => (attempt === 1 ? replayed : taskProblem(404, 'task.not-found')),
      async (adapter, calls) => {
        await expect(adapter.apply(claim, 'review')).resolves.toEqual({
          disposition: 'unavailable',
        });
        expect(calls).toHaveLength(2);
        expect(JSON.parse(calls[1]?.body ?? '')).toMatchObject({
          mappingAuthorUserId,
          status: null,
        });
      },
    );
  });

  it.each([
    { reason: 'replayed', receipt: { ...replayed, body: authorized.body } },
    {
      reason: 'applied',
      receipt: { ...authorized, body: JSON.stringify({ ...receipt, disposition: 'applied' }) },
    },
    {
      reason: 'for a different task',
      receipt: { ...authorized, body: JSON.stringify({ ...receipt, taskId: integrationId }) },
    },
  ])('fails a placement check with a receipt that is $reason', async ({ receipt }) => {
    await withTaskServer(
      signer,
      (attempt) => (attempt === 1 ? replayed : receipt),
      async (adapter) => {
        await expect(adapter.apply(claim, 'review')).rejects.toThrow('current placement');
      },
    );
  });

  it('retries the original action key and creates a fresh key for each placement check', async () => {
    const replies = [replayed, taskProblem(503, 'task.action-unavailable'), replayed, authorized];
    await withTaskServer(
      signer,
      (attempt) => replies[attempt - 1] ?? taskProblem(500, 'http.internal-server-error'),
      async (adapter, calls) => {
        await expect(adapter.apply(claim, 'review')).rejects.toMatchObject({
          problem: { status: 503 },
        });
        await expect(adapter.apply(claim, 'review')).resolves.toEqual({
          ...receipt,
          disposition: 'applied',
        });
        const keys = calls.map((call) => call.headers['idempotency-key']);
        expect(keys).toHaveLength(4);
        expect(keys[0]).toBe(claim.commandKey);
        expect(keys[2]).toBe(claim.commandKey);
        expect(new Set(keys).size).toBe(3);
      },
    );
  });

  it.each([
    {
      name: 'cacheable',
      response: { ...authorized, headers: { 'Content-Type': 'application/json' } },
    },
    {
      name: 'from another space',
      response: { ...authorized, body: JSON.stringify({ ...receipt, spaceId: organizationId }) },
    },
    {
      name: 'missing stable placement',
      response: { ...authorized, body: JSON.stringify({ disposition: 'applied' }) },
    },
    {
      name: 'carrying extra data',
      response: { ...authorized, body: JSON.stringify({ ...receipt, title: 'test' }) },
    },
    { name: 'malformed', response: { ...authorized, body: '{' } },
    {
      name: 'marked with an invalid replay header',
      response: {
        ...authorized,
        headers: { ...authorized.headers, 'Idempotent-Replayed': 'false' },
      },
    },
  ])('rejects a receipt that is $name', async ({ response }) => {
    await withTaskServer(
      signer,
      () => response,
      async (adapter) => {
        await expect(adapter.apply(claim, 'done')).rejects.toThrow();
      },
    );
  });

  it('leaves a temporary Task failure uncertain and retries the same command key', async () => {
    await withTaskServer(
      signer,
      (attempt) => (attempt <= 2 ? taskProblem(503, 'task.action-unavailable') : authorized),
      async (adapter, calls) => {
        await expect(adapter.apply(claim, 'done')).rejects.toMatchObject({
          problem: { status: 503 },
        });
        await expect(adapter.apply(claim, 'done')).resolves.toEqual(receipt);
        expect(calls.map((call) => call.headers['idempotency-key'])).toEqual([
          claim.commandKey,
          claim.commandKey,
          claim.commandKey,
        ]);
        expect(new Set(calls.map((call) => call.body)).size).toBe(1);
      },
    );
  });

  describe('merge intent submission', () => {
    const command = {
      organizationId,
      linkId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e09',
      attempt: 2,
      commandKey: claim.commandKey,
      taskKey: 'CAD-482',
      mapping: claim.mapping,
      status: 'done',
    } as const;

    it('sends done under the intent key and confirms a replayed receipt', async () => {
      await withTaskServer(
        signer,
        () => replayed,
        async (adapter, calls) => {
          await expect(adapter.submitMergeIntent(command)).resolves.toEqual({
            kind: 'confirmed',
            disposition: 'applied',
          });
          expect(calls).toHaveLength(1);
          expect(calls[0]?.headers['idempotency-key']).toBe(command.commandKey);
          expect(JSON.parse(calls[0]?.body ?? '')).toMatchObject({ status: 'done' });
        },
      );
    });

    it.each([
      [404, 'task.not-found'],
      [422, 'idempotency.key-reused'],
      [409, 'task.trashed'],
    ])('records the definitive %s %s refusal with its reason', async (status, code) => {
      await withTaskServer(
        signer,
        () => taskProblem(status, code),
        async (adapter) => {
          await expect(adapter.submitMergeIntent(command)).resolves.toEqual({
            kind: 'refused',
            reason: code,
          });
        },
      );
    });

    it.each([
      [503, 'task.action-unavailable'],
      [409, 'idempotency.request-in-progress'],
      [404, 'http.not-found'],
    ])('treats %s %s as a failure to retry under the same key', async (status, code) => {
      await withTaskServer(
        signer,
        () => taskProblem(status, code),
        async (adapter) => {
          await expect(adapter.submitMergeIntent(command)).resolves.toEqual({ kind: 'failed' });
        },
      );
    });
  });
});
