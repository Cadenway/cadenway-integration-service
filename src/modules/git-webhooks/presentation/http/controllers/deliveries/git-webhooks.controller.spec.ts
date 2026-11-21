import type { InternalPrincipal } from '@cadenway/nest-common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AdmitGitWebhook } from '../../../../application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.use-case.js';
import { GitWebhooksController } from './git-webhooks.controller.js';

const bindingId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const deliveryId = '806f0650-bdef-4474-a5cf-22b60c810f76';
const signature = `sha256=${'a'.repeat(64)}`;
const principal: InternalPrincipal = {
  issuer: 'api-gateway',
  audience: 'integration-service',
  actor: { type: 'system', id: 'api-gateway' },
  organizationId: null,
  role: null,
  scopes: [],
  traceId: null,
};

function githubRequest(): Request {
  const request = {
    query: { bindingId },
    body: Buffer.from('{ "action": "opened" }\n'),
    rawHeaders: [
      'X-GitHub-Delivery',
      deliveryId,
      'X-GitHub-Event',
      'pull_request',
      'X-Hub-Signature-256',
      signature,
    ],
    is: () => 'application/json',
  } as unknown as Request;
  Object.assign(request, { internalPrincipal: principal });
  return request;
}

describe('GitWebhooksController', () => {
  it('passes the exact authenticated-provider bytes to the intake', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'accepted' });
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    const request = githubRequest();
    const body: unknown = request.body;

    await expect(controller.github(request)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith({
      provider: 'github',
      bindingId,
      deliveryId,
      event: 'pull_request',
      signature,
      rawBody: body,
    });
  });

  it('rejects an unknown query and repeated provider headers without admission', async () => {
    const execute = vi.fn();
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    const request = githubRequest();
    request.rawHeaders.push('X-GitHub-Event', 'push');
    await expect(controller.github(request)).rejects.toMatchObject({
      problem: { code: 'request.invalid', status: 400 },
    });
    const extra = githubRequest();
    extra.query = { bindingId, organizationId: bindingId };
    await expect(controller.github(extra)).rejects.toMatchObject({
      problem: { code: 'request.invalid', status: 400 },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards GitLab signed timestamp text and bytes unchanged', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'accepted' });
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    const request = githubRequest();
    request.rawHeaders = [
      'webhook-id',
      deliveryId,
      'X-Gitlab-Event',
      'Merge Request Hook',
      'webhook-timestamp',
      '01700000000',
      'webhook-signature',
      'v1,signature',
    ];
    const body: unknown = request.body;
    await expect(controller.gitlab(request)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith({
      provider: 'gitlab',
      bindingId,
      deliveryId,
      event: 'Merge Request Hook',
      timestamp: '01700000000',
      signature: 'v1,signature',
      rawBody: body,
      currentUnixSeconds: expect.any(Number) as number,
    });
  });

  it.each([
    [],
    ['webhook-timestamp', 'unknown'],
    ['webhook-timestamp', '1700000000', 'webhook-timestamp', '1700000001'],
  ])(
    'uses the same response for absent, malformed or repeated GitLab timestamps',
    async (...timestamp) => {
      const execute = vi.fn();
      const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
      const request = githubRequest();
      request.rawHeaders = [
        'webhook-id',
        deliveryId,
        'X-Gitlab-Event',
        'Merge Request Hook',
        'webhook-signature',
        'v1,signature',
        ...timestamp,
      ];
      await expect(controller.gitlab(request)).rejects.toMatchObject({
        problem: { code: 'webhook.authentication-failed', status: 403 },
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('refuses another verified actor or an organization claim before admission', async () => {
    const execute = vi.fn();
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    const wrongActor = githubRequest();
    Object.assign(wrongActor, {
      internalPrincipal: { ...principal, actor: { type: 'system', id: 'other' } },
    });
    await expect(controller.github(wrongActor)).rejects.toMatchObject({
      problem: { code: 'auth.actor-not-allowed', status: 403 },
    });
    const scoped = githubRequest();
    Object.assign(scoped, { internalPrincipal: { ...principal, organizationId: bindingId } });
    await expect(controller.github(scoped)).rejects.toMatchObject({
      problem: { code: 'auth.organization-not-allowed', status: 403 },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a missing signature or a decoded body before admission', async () => {
    const execute = vi.fn();
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    const unsigned = githubRequest();
    unsigned.rawHeaders.splice(4, 2);
    await expect(controller.github(unsigned)).rejects.toMatchObject({
      problem: { code: 'webhook.authentication-failed', status: 403 },
    });
    const decoded = githubRequest();
    decoded.body = { action: 'opened' };
    await expect(controller.github(decoded)).rejects.toMatchObject({
      problem: { code: 'request.invalid', status: 400 },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps failed authentication and malformed authenticated delivery to fixed problems', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 'authentication-failed' })
      .mockResolvedValueOnce({ status: 'invalid-delivery' });
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    await expect(controller.github(githubRequest())).rejects.toMatchObject({
      problem: { code: 'webhook.authentication-failed', status: 403 },
    });
    await expect(controller.github(githubRequest())).rejects.toMatchObject({
      problem: { code: 'webhook.invalid-delivery', status: 400 },
    });
  });

  it('maps an intake failure to an unavailable problem without leaking its message', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('sensitive provider input'));
    const controller = new GitWebhooksController({ execute } as unknown as AdmitGitWebhook);
    await expect(controller.github(githubRequest())).rejects.toMatchObject({
      problem: { code: 'integration.unavailable', status: 503 },
    });
  });
});
