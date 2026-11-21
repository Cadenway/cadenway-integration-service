import { describe, expect, it, vi } from 'vitest';

import type { GitWebhookInput } from '../../../../models/deliveries/git-webhook-input.model.js';
import type { GitDeliveryTransaction } from '../../../../ports/outbound/transactions/deliveries/git-delivery-transaction.port.js';
import type { GitDeliveryUnitOfWork } from '../../../../ports/outbound/transactions/deliveries/git-delivery-unit-of-work.port.js';
import { AdmitGitWebhook } from './admit-git-webhook.use-case.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const receiver = {
  bindingId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  organizationId,
  provider: 'github' as const,
  revision: 1,
  signingSecret: 'fixture-key',
};
const mapping = {
  binding: { provider: 'github' as const, installationId: 41, repositoryId: 501 },
  integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
  spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
  mappingAuthorUserId: '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32',
};
const payload = {
  repository: { id: 501 },
  installation: { id: 41 },
  number: 214,
  action: 'opened',
  pull_request: {
    number: 214,
    state: 'open',
    merged: false,
    head: { ref: 'cad-482-connexion', repo: { id: 501 } },
    base: { ref: 'main', repo: { id: 501 } },
    title: 'CAD-482',
  },
};
const input: GitWebhookInput = {
  provider: 'github',
  bindingId: receiver.bindingId,
  deliveryId: '806f0650-bdef-4474-a5cf-22b60c810f76',
  event: 'pull_request',
  signature: 'provider-signature',
  rawBody: new TextEncoder().encode(JSON.stringify(payload)),
};

function setup(): {
  readonly command: AdmitGitWebhook;
  readonly transaction: GitDeliveryTransaction;
  readonly work: GitDeliveryUnitOfWork;
  readonly verify: ReturnType<typeof vi.fn>;
} {
  const transaction: GitDeliveryTransaction = {
    checkDeliveryId: vi.fn().mockResolvedValue('new'),
    findMapping: vi.fn().mockResolvedValue(mapping),
    admit: vi.fn().mockResolvedValue('accepted'),
  };
  const work: GitDeliveryUnitOfWork = {
    findReceiver: vi.fn().mockResolvedValue(receiver),
    run: async (_receiver, callback) => ({ active: true, result: await callback(transaction) }),
  };
  const verify = vi.fn().mockReturnValue('a'.repeat(64));
  return { command: new AdmitGitWebhook(work, { verify }), transaction, work, verify };
}

describe('AdmitGitWebhook', () => {
  it('authenticates the original bytes before resolving the signed mapping and atomically admitting CAD-482', async () => {
    const { command, transaction, verify } = setup();
    await expect(command.execute(input)).resolves.toEqual({ status: 'accepted' });
    expect(verify).toHaveBeenCalledWith(input, receiver.signingSecret);
    expect(transaction.checkDeliveryId).toHaveBeenCalledExactlyOnceWith(
      input.deliveryId,
      'a'.repeat(64),
    );
    expect(transaction.findMapping).toHaveBeenCalledWith({
      provider: 'github',
      installationId: 41,
      repositoryId: 501,
    });
    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
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
  });

  it('rejects invalid signatures before decoding or beginning an admission transaction', async () => {
    const { command, transaction, verify } = setup();
    verify.mockReturnValue(null);
    await expect(command.execute({ ...input, rawBody: Uint8Array.of(0xff) })).resolves.toEqual({
      status: 'authentication-failed',
    });
    expect(transaction.checkDeliveryId).not.toHaveBeenCalled();
    expect(transaction.findMapping).not.toHaveBeenCalled();
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 after authentication and before recording work', async () => {
    const { command, transaction } = setup();
    await expect(command.execute({ ...input, rawBody: Uint8Array.of(0xff) })).resolves.toEqual({
      status: 'invalid-delivery',
    });
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('rejects a mismatched untrusted event header before recording a digest', async () => {
    const { command, transaction } = setup();
    await expect(command.execute({ ...input, event: 'create' })).resolves.toEqual({
      status: 'invalid-delivery',
    });
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('records ignored bound deliveries without creating Task work', async () => {
    const { command, transaction } = setup();
    const ignored = { ...payload, action: 'synchronize' };
    await expect(
      command.execute({ ...input, rawBody: new TextEncoder().encode(JSON.stringify(ignored)) }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: null,
    });
  });

  it.each([
    { event: 'pull_request', body: { ...payload, repository: { id: 502 } } },
    { event: 'ping', body: {} },
  ])(
    'rejects reused IDs with different bytes for $event even without a mapping',
    async ({ event, body }) => {
      const { command, transaction } = setup();
      vi.mocked(transaction.checkDeliveryId).mockResolvedValue('conflict');
      vi.mocked(transaction.findMapping).mockResolvedValue(null);
      const unrelated = new TextEncoder().encode(JSON.stringify(body));
      await expect(command.execute({ ...input, event, rawBody: unrelated })).resolves.toEqual({
        status: 'invalid-delivery',
      });
      expect(transaction.findMapping).not.toHaveBeenCalled();
      expect(transaction.admit).not.toHaveBeenCalled();
    },
  );

  it('acknowledges the known authenticated body even after the mapping is revoked', async () => {
    const { command, transaction } = setup();
    vi.mocked(transaction.checkDeliveryId).mockResolvedValue('duplicate');
    vi.mocked(transaction.findMapping).mockResolvedValue(null);
    await expect(command.execute({ ...input, event: 'ping' })).resolves.toEqual({
      status: 'accepted',
    });
    expect(transaction.findMapping).not.toHaveBeenCalled();
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('looks up and records GitHub UUIDs in lowercase after verification', async () => {
    const { command, transaction, verify } = setup();
    const upper = { ...input, deliveryId: input.deliveryId.toUpperCase() };
    await expect(command.execute(upper)).resolves.toEqual({ status: 'accepted' });
    expect(verify).toHaveBeenCalledWith(upper, receiver.signingSecret);
    expect(transaction.checkDeliveryId).toHaveBeenCalledExactlyOnceWith(
      input.deliveryId,
      'a'.repeat(64),
    );
    expect(transaction.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deliveryId: input.deliveryId }),
    );
  });

  it('can record an authenticated alias after checking the current mapping and event', async () => {
    const { command, transaction } = setup();
    vi.mocked(transaction.admit).mockResolvedValue('duplicate');
    const deliveryId = '806f0650-bdef-4474-a5cf-22b60c810f77';
    await expect(command.execute({ ...input, deliveryId })).resolves.toEqual({
      status: 'accepted',
    });
    expect(transaction.checkDeliveryId).toHaveBeenCalledExactlyOnceWith(deliveryId, 'a'.repeat(64));
    expect(transaction.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deliveryId, digest: 'a'.repeat(64) }),
    );
  });

  it('fails closed if the receiver is revoked after signature verification', async () => {
    const { command, work, transaction } = setup();
    vi.spyOn(work, 'run').mockResolvedValue({ active: false });
    await expect(command.execute(input)).resolves.toEqual({ status: 'authentication-failed' });
    expect(transaction.checkDeliveryId).not.toHaveBeenCalled();
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('does not use an unmatched repository to select an organization', async () => {
    const { command, transaction } = setup();
    vi.mocked(transaction.findMapping).mockResolvedValue(null);
    await expect(command.execute(input)).resolves.toEqual({ status: 'authentication-failed' });
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('resolves a verified GitLab project under its receiver', async () => {
    const { command, work, transaction } = setup();
    vi.mocked(work.findReceiver).mockResolvedValue({ ...receiver, provider: 'gitlab' });
    const gitlabMapping = {
      ...mapping,
      binding: { provider: 'gitlab' as const, repositoryId: 701 },
    };
    vi.mocked(transaction.findMapping).mockResolvedValue(gitlabMapping);
    const body = {
      object_kind: 'merge_request',
      event_type: 'merge_request',
      project: { id: 701 },
      object_attributes: {
        iid: 31,
        state: 'opened',
        action: 'open',
        source_project_id: 701,
        target_project_id: 701,
        source_branch: 'cad-482-connexion',
      },
    };
    const deliveryId = input.deliveryId.toUpperCase();
    await expect(
      command.execute({
        provider: 'gitlab',
        bindingId: receiver.bindingId,
        deliveryId,
        event: 'Merge Request Hook',
        signature: 'v1,signature',
        timestamp: '1700000000',
        currentUnixSeconds: 1700000000,
        rawBody: new TextEncoder().encode(JSON.stringify(body)),
      }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(transaction.checkDeliveryId).toHaveBeenCalledExactlyOnceWith(deliveryId, 'a'.repeat(64));
    expect(transaction.findMapping).toHaveBeenCalledWith({ provider: 'gitlab', repositoryId: 701 });
    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId,
      digest: 'a'.repeat(64),
      work: {
        mapping: gitlabMapping,
        fact: {
          kind: 'actionable',
          trigger: 'pr_open',
          requestNumber: 31,
          taskKeys: ['CAD-482'],
          closingTaskKeys: [],
        },
      },
    });
  });

  it('returns the same authentication refusal for an unknown receiver', async () => {
    const { command, verify, work } = setup();
    vi.mocked(work.findReceiver).mockResolvedValue(null);
    await expect(command.execute(input)).resolves.toEqual({ status: 'authentication-failed' });
    expect(verify).not.toHaveBeenCalled();
  });
});
