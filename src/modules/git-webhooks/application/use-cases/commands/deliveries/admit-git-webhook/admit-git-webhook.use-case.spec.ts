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
    checkDelivery: vi.fn().mockResolvedValue('new'),
    findMapping: vi.fn().mockResolvedValue(mapping),
    findRequestTaskKeys: vi.fn().mockResolvedValue([]),
    findPendingRequestWork: vi.fn().mockResolvedValue([]),
    recordCheckObservation: vi.fn().mockResolvedValue(undefined),
    findHeadTargets: vi.fn().mockResolvedValue([]),
    admit: vi.fn().mockResolvedValue('accepted'),
  };
  const work: GitDeliveryUnitOfWork = {
    findReceiver: vi.fn().mockResolvedValue(receiver),
    run: async (_receiver, callback) => ({ active: true, result: await callback(transaction) }),
  };
  const verify = vi.fn().mockReturnValue('a'.repeat(64));
  return { command: new AdmitGitWebhook(work, { verify }), transaction, work, verify };
}

/** Matches the asserted fact members while ignoring the request snapshot. */
function objectContaining(value: object): unknown {
  return expect.objectContaining(value) as unknown;
}

describe('AdmitGitWebhook', () => {
  it('authenticates the original bytes before resolving the signed mapping and atomically admitting CAD-482', async () => {
    const { command, transaction, verify } = setup();
    await expect(command.execute(input)).resolves.toEqual({ status: 'accepted' });
    expect(verify).toHaveBeenCalledWith(input, receiver.signingSecret);
    expect(transaction.checkDelivery).toHaveBeenCalledExactlyOnceWith(
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
        fact: objectContaining({
          kind: 'actionable',
          trigger: 'pr_open',
          requestNumber: 214,
          taskKeys: ['CAD-482'],
          closingTaskKeys: [],
        }),
      },
    });
  });

  it('rejects invalid signatures before decoding or beginning an admission transaction', async () => {
    const { command, transaction, verify } = setup();
    verify.mockReturnValue(null);
    await expect(command.execute({ ...input, rawBody: Uint8Array.of(0xff) })).resolves.toEqual({
      status: 'authentication-failed',
    });
    expect(transaction.checkDelivery).not.toHaveBeenCalled();
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

  it.each(['No remaining reference', 'Closes CAD-499'])(
    'closes only existing linked tasks with the edited title "%s"',
    async (title) => {
      const { command, transaction } = setup();
      vi.mocked(transaction.findRequestTaskKeys).mockResolvedValue(['CAD-483']);
      const closed = {
        ...payload,
        action: 'closed',
        pull_request: {
          ...payload.pull_request,
          state: 'closed',
          head: { ref: 'revised-branch', repo: { id: 501 } },
          title,
        },
      };
      await expect(
        command.execute({ ...input, rawBody: new TextEncoder().encode(JSON.stringify(closed)) }),
      ).resolves.toEqual({ status: 'accepted' });
      expect(transaction.findRequestTaskKeys).toHaveBeenCalledWith(mapping.binding, 214, undefined);
      expect(transaction.admit).toHaveBeenCalledWith({
        deliveryId: input.deliveryId,
        digest: 'a'.repeat(64),
        work: {
          mapping,
          fact: objectContaining({
            kind: 'actionable',
            trigger: 'pr_closed',
            requestNumber: 214,
            taskKeys: ['CAD-483'],
            closingTaskKeys: [],
          }),
        },
      });
    },
  );

  it.each([
    { title: 'No remaining reference', explicitlyReferenced: [], closing: [] },
    { title: 'Closes CAD-483', explicitlyReferenced: ['CAD-483'], closing: ['CAD-483'] },
  ])(
    'adopts the merged fact for previous links and pending openings with "$title"',
    async ({ title, explicitlyReferenced, closing }) => {
      const { command, transaction } = setup();
      const predecessor = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e10';
      vi.mocked(transaction.findRequestTaskKeys).mockResolvedValue(['CAD-482', 'CAD-483']);
      vi.mocked(transaction.findPendingRequestWork).mockResolvedValue([
        { id: predecessor, taskKeys: ['CAD-482', 'CAD-484'] },
      ]);
      const merged = {
        ...payload,
        action: 'closed',
        pull_request: {
          ...payload.pull_request,
          state: 'closed',
          merged: true,
          head: { ref: 'revised-branch', repo: { id: 501 } },
          title,
        },
      };

      await expect(
        command.execute({ ...input, rawBody: new TextEncoder().encode(JSON.stringify(merged)) }),
      ).resolves.toEqual({ status: 'accepted' });
      expect(transaction.findRequestTaskKeys).toHaveBeenCalledWith(mapping.binding, 214, undefined);
      expect(transaction.admit).toHaveBeenCalledWith({
        deliveryId: input.deliveryId,
        digest: 'a'.repeat(64),
        work: {
          mapping,
          fact: objectContaining({
            kind: 'actionable',
            trigger: 'pr_merged',
            requestNumber: 214,
            taskKeys: ['CAD-482', 'CAD-483', 'CAD-484'],
            closingTaskKeys: closing,
            referencedTaskKeys: explicitlyReferenced,
          }),
          prerequisiteIds: [predecessor],
        },
      });
    },
  );

  it('keeps recorded links and a new signed closing target when pending targets exceed the bound', async () => {
    const { command, transaction } = setup();
    const linked = Array.from({ length: 20 }, (_, index) => 'CAD-' + String(index + 1));
    const predecessor = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e10';
    vi.mocked(transaction.findRequestTaskKeys).mockResolvedValue(linked);
    vi.mocked(transaction.findPendingRequestWork).mockResolvedValue([
      { id: predecessor, taskKeys: ['CAD-21'] },
    ]);
    const merged = {
      ...payload,
      action: 'closed',
      pull_request: {
        ...payload.pull_request,
        state: 'closed',
        merged: true,
        head: { ref: 'revised-branch', repo: { id: 501 } },
        title: 'Closes CAD-22',
      },
    };

    await command.execute({ ...input, rawBody: new TextEncoder().encode(JSON.stringify(merged)) });

    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: {
        mapping,
        fact: objectContaining({
          kind: 'actionable',
          trigger: 'pr_merged',
          requestNumber: 214,
          taskKeys: [...linked, 'CAD-22'],
          closingTaskKeys: ['CAD-22'],
          referencedTaskKeys: ['CAD-22'],
        }),
        prerequisiteIds: [predecessor],
      },
    });
  });

  it('admits checks only for the repository request and its matching observed head', async () => {
    const { command, transaction } = setup();
    const headSha = 'a'.repeat(40);
    const when = '2026-11-08T20:18:44Z';
    const body = {
      action: 'completed',
      installation: payload.installation,
      repository: payload.repository,
      check_suite: {
        id: 277,
        status: 'completed',
        conclusion: 'success',
        updated_at: when,
        head_sha: headSha,
        head_branch: payload.pull_request.head.ref,
        pull_requests: [
          {
            ...payload.pull_request,
            head: { ...payload.pull_request.head, sha: headSha },
          },
        ],
      },
    };
    const rawBody = new TextEncoder().encode(JSON.stringify(body));
    await expect(command.execute({ ...input, event: 'pull_request', rawBody })).resolves.toEqual({
      status: 'invalid-delivery',
    });
    expect(transaction.findRequestTaskKeys).not.toHaveBeenCalled();
    expect(transaction.admit).not.toHaveBeenCalled();
    expect(transaction.recordCheckObservation).not.toHaveBeenCalled();

    const checkInput = { ...input, event: 'check_suite', rawBody };
    await expect(command.execute(checkInput)).resolves.toEqual({ status: 'accepted' });
    // The observation is kept for the repository and head even though no link has that head yet.
    expect(transaction.recordCheckObservation).toHaveBeenLastCalledWith(mapping.binding, {
      provider: 'github',
      attemptId: 277,
      headSha,
      observedAtMs: Date.parse(when),
      completedAtMs: Date.parse(when),
      status: 'completed',
      conclusion: 'success',
    });
    expect(transaction.admit).toHaveBeenLastCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: null,
    });

    vi.mocked(transaction.findRequestTaskKeys).mockResolvedValue(['CAD-484']);
    await expect(command.execute(checkInput)).resolves.toEqual({ status: 'accepted' });
    expect(transaction.findRequestTaskKeys).toHaveBeenLastCalledWith(mapping.binding, 214, headSha);
    expect(transaction.admit).toHaveBeenLastCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: {
        mapping,
        fact: objectContaining({
          kind: 'actionable',
          trigger: 'pr_checks',
          requestNumber: 214,
          taskKeys: ['CAD-484'],
          closingTaskKeys: [],
          checks: {
            requestNumber: 214,
            headSha,
            attemptId: 277,
            completedAtMs: Date.parse(when),
            observed: true,
          },
        }),
      },
    });
  });

  it('keeps a suite observation without request work when GitHub names no single PR', async () => {
    const { command, transaction } = setup();
    const headSha = 'b'.repeat(40);
    const body = {
      action: 'requested',
      installation: payload.installation,
      repository: payload.repository,
      check_suite: {
        id: 278,
        status: 'queued',
        conclusion: null,
        updated_at: '2026-11-08T20:18:44Z',
        head_sha: headSha,
        head_branch: payload.pull_request.head.ref,
        pull_requests: [],
      },
    };
    await expect(
      command.execute({
        ...input,
        event: 'check_suite',
        rawBody: new TextEncoder().encode(JSON.stringify(body)),
      }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(transaction.recordCheckObservation).toHaveBeenCalledWith(
      mapping.binding,
      expect.objectContaining({ attemptId: 278, headSha, status: 'queued', completedAtMs: null }),
    );
    expect(transaction.findRequestTaskKeys).not.toHaveBeenCalled();
    expect(transaction.findHeadTargets).toHaveBeenCalledWith(mapping.binding, headSha);
    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: null,
    });

    // Existing links whose current head is the suite's head are refreshed.
    const targets = [
      { taskKey: 'CAD-482', requestNumber: 214 },
      { taskKey: 'CAD-482', requestNumber: 215 },
      { taskKey: 'CAD-483', requestNumber: 215 },
    ];
    vi.mocked(transaction.findHeadTargets).mockResolvedValue(targets);
    await expect(
      command.execute({
        ...input,
        event: 'check_suite',
        rawBody: new TextEncoder().encode(JSON.stringify(body)),
      }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(transaction.admit).toHaveBeenLastCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: {
        mapping,
        fact: {
          kind: 'actionable',
          trigger: 'head_checks',
          headSha,
          targets,
          checks: {
            headSha,
            attemptId: 278,
            completedAtMs: Date.parse('2026-11-08T20:18:44Z'),
            observed: true,
          },
          taskKeys: ['CAD-482', 'CAD-483'],
          closingTaskKeys: [],
        },
      },
    });
  });

  it.each(['reopened', 'edited', 'ready_for_review', 'review_requested'])(
    'admits a GitHub %s delivery for the existing links of the request only',
    async (action) => {
      const { command, transaction } = setup();
      vi.mocked(transaction.findRequestTaskKeys).mockResolvedValue(['CAD-482']);
      const body = {
        ...payload,
        action,
        pull_request: { ...payload.pull_request, updated_at: '2026-11-08T20:18:44Z' },
      };
      await expect(
        command.execute({ ...input, rawBody: new TextEncoder().encode(JSON.stringify(body)) }),
      ).resolves.toEqual({ status: 'accepted' });
      expect(transaction.findRequestTaskKeys).toHaveBeenCalledWith(mapping.binding, 214, undefined);
      expect(transaction.admit).toHaveBeenCalledWith({
        deliveryId: input.deliveryId,
        digest: 'a'.repeat(64),
        work: {
          mapping,
          fact: objectContaining({
            trigger: action === 'reopened' ? 'pr_reopened' : 'pr_updated',
            taskKeys: ['CAD-482'],
          }),
        },
      });
    },
  );

  it('retains closure for a preceding authorized opening that has not yet created the link', async () => {
    const { command, transaction } = setup();
    const id = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e10';
    vi.mocked(transaction.findPendingRequestWork).mockResolvedValue([
      { id, taskKeys: ['CAD-482'] },
    ]);
    const closed = {
      ...payload,
      action: 'closed',
      pull_request: { ...payload.pull_request, state: 'closed' },
    };
    await expect(
      command.execute({ ...input, rawBody: new TextEncoder().encode(JSON.stringify(closed)) }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(transaction.findPendingRequestWork).toHaveBeenCalledWith(mapping, 214, [
      'pr_open',
      'pr_merged',
    ]);
    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId: input.deliveryId,
      digest: 'a'.repeat(64),
      work: {
        mapping,
        fact: objectContaining({
          kind: 'actionable',
          trigger: 'pr_closed',
          requestNumber: 214,
          taskKeys: ['CAD-482'],
          closingTaskKeys: [],
        }),
        prerequisiteIds: [id],
      },
    });
  });

  it.each([
    { event: 'pull_request', body: { ...payload, repository: { id: 502 } } },
    { event: 'ping', body: {} },
  ])(
    'rejects reused IDs with different bytes for $event even without a mapping',
    async ({ event, body }) => {
      const { command, transaction } = setup();
      vi.mocked(transaction.checkDelivery).mockResolvedValue('conflict');
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
    vi.mocked(transaction.checkDelivery).mockResolvedValue('duplicate');
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
    expect(transaction.checkDelivery).toHaveBeenCalledExactlyOnceWith(
      input.deliveryId,
      'a'.repeat(64),
    );
    expect(transaction.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deliveryId: input.deliveryId }),
    );
  });

  it('acknowledges a known GitHub digest without recording an additional delivery ID', async () => {
    const { command, transaction } = setup();
    vi.mocked(transaction.checkDelivery).mockResolvedValue('duplicate');
    const deliveryId = '806f0650-bdef-4474-a5cf-22b60c810f77';
    await expect(command.execute({ ...input, deliveryId })).resolves.toEqual({
      status: 'accepted',
    });
    expect(transaction.checkDelivery).toHaveBeenCalledExactlyOnceWith(deliveryId, 'a'.repeat(64));
    expect(transaction.findMapping).not.toHaveBeenCalled();
    expect(transaction.admit).not.toHaveBeenCalled();
  });

  it('fails closed if the receiver is revoked after signature verification', async () => {
    const { command, work, transaction } = setup();
    vi.spyOn(work, 'run').mockResolvedValue({ active: false });
    await expect(command.execute(input)).resolves.toEqual({ status: 'authentication-failed' });
    expect(transaction.checkDelivery).not.toHaveBeenCalled();
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
    expect(transaction.checkDelivery).toHaveBeenCalledExactlyOnceWith(deliveryId, 'a'.repeat(64));
    expect(transaction.findMapping).toHaveBeenCalledWith({ provider: 'gitlab', repositoryId: 701 });
    expect(transaction.admit).toHaveBeenCalledWith({
      deliveryId,
      digest: 'a'.repeat(64),
      work: {
        mapping: gitlabMapping,
        fact: objectContaining({
          kind: 'actionable',
          trigger: 'pr_open',
          requestNumber: 31,
          taskKeys: ['CAD-482'],
          closingTaskKeys: [],
        }),
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
