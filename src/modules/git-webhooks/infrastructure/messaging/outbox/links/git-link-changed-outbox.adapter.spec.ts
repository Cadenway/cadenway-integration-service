import {
  GIT_BRANCH_CREATED_V1,
  GIT_PR_MERGED_V1,
  GIT_PR_OPENED_V1,
  eventSchemas,
} from '@cadenway/contracts/events/integration-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { describe, expect, it, vi } from 'vitest';

import { GitLinkChangedOutbox } from './git-link-changed-outbox.adapter.js';

const envelope = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d4f',
  occurredAt: '2026-11-08T10:41:00.000Z',
};
const target = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  gitLinkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
  taskKey: 'CAD-482',
  placement: {
    disposition: 'no_op',
    taskId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e09',
    spaceId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01',
    listId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12',
  },
} as const;

function setup() {
  const append = vi.fn<OutboxWriter['append']>().mockResolvedValue(envelope);
  const scope = {
    kind: 'tenant',
    organizationId: target.organizationId,
  } as TransactionScope<DatabaseSchema>;
  return { append, adapter: new GitLinkChangedOutbox({ append }), scope };
}

describe('GitLinkChangedOutbox', () => {
  it.each([
    ['branch-created', GIT_BRANCH_CREATED_V1, 'branch', 1],
    ['pull-request-opened', GIT_PR_OPENED_V1, 'state', 1],
    ['pull-request-merged', GIT_PR_MERGED_V1, 'state', 2],
  ] as const)(
    'appends the published %s fact with only its authorized placement',
    async (type, name, changed, version) => {
      const { append, adapter, scope } = setup();
      const changeWithProviderData = {
        ...target,
        event: { type, version },
        repository: 'atelier-nord',
        title: 'Private pull request',
        ref: 'refs/heads/private',
      };

      await adapter.append(scope, changeWithProviderData);

      expect(append).toHaveBeenCalledOnce();
      const [usedScope, schemas, usedName, data] = append.mock.calls[0] ?? [];
      expect(usedScope).toBe(scope);
      expect(schemas).toBe(eventSchemas);
      expect(usedName).toBe(name);
      expect(eventSchemas[name].parse({ ...data, ...envelope })).toEqual({
        ...envelope,
        organizationId: target.organizationId,
        actor: { type: 'git', id: target.integrationId },
        version,
        taskKey: target.taskKey,
        spaceId: target.placement.spaceId,
        listId: target.placement.listId,
        gitLinkId: target.gitLinkId,
        changed: [changed],
      });
    },
  );

  it('refuses another tenant and the system transaction before appending', async () => {
    const { append, adapter, scope } = setup();
    const change = { ...target, event: { type: 'branch-created', version: 1 } } as const;

    await expect(
      adapter.append({ ...scope, organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2e' }, change),
    ).rejects.toThrow('tenant transaction');
    await expect(
      adapter.append({ ...scope, kind: 'system', organizationId: null }, change),
    ).rejects.toThrow('tenant transaction');
    expect(append).not.toHaveBeenCalled();
  });

  it('propagates an append failure to the transaction owner', async () => {
    const { append, adapter, scope } = setup();
    const failure = new Error('Outbox unavailable.');
    append.mockRejectedValueOnce(failure);

    await expect(
      adapter.append(scope, { ...target, event: { type: 'branch-created', version: 1 } }),
    ).rejects.toBe(failure);
  });
});
