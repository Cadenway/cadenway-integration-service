import { eventSchemas, TASK_PURGED_V1 } from '@cadenway/contracts/events/integration-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { PurgeTaskGitLinks } from '../../../../application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';
import { TaskPurgedHandler } from './task-purged.handler.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const event = eventSchemas[TASK_PURGED_V1].parse({
  id: '019a700b-1a2b-7c3d-8e4f-5A6B7C8D9E01',
  organizationId,
  occurredAt: '2026-11-21T12:00:00.000Z',
  actor: { type: 'system', id: 'task-service' },
  version: 3,
  key: 'CAD-482',
  rootKey: 'CAD-481',
  parentKey: 'CAD-481',
  entryId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
  spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
  listId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e04',
});

function inTenant<T>(tenant: string, work: () => T): T {
  return runWithOrganizationContext(
    {
      organizationId: tenant,
      actor: { type: 'system', id: 'task-service' },
      role: null,
      scopes: [],
    },
    work,
  );
}

async function setup() {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const execute = vi.fn<PurgeTaskGitLinks['execute']>().mockResolvedValue(undefined);
  await new TaskPurgedHandler({ subscribe }, { execute }).onApplicationBootstrap();
  const subscription = subscribe.mock.calls[0]?.[0];
  if (subscription === undefined) throw new Error('Missing Task purge subscription.');
  const controller = new AbortController();
  const delivery: EventContext = {
    deliveryCount: 1,
    streamSequence: 1,
    redelivered: false,
    claimVersion: vi.fn().mockResolvedValue(true),
    signal: controller.signal,
  };
  return { subscription, execute, delivery, controller };
}

describe('TaskPurgedHandler', () => {
  it('replays retained facts with the published contract and deletes the purged child only', async () => {
    const { subscription, execute, delivery } = await setup();
    expect(subscription).toMatchObject({
      handler: 'purge-task-git-links',
      event: TASK_PURGED_V1,
      schemas: eventSchemas,
      deliverPolicy: 'all',
    });

    await inTenant(organizationId, () => subscription.handle(event, delivery));
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      eventId: event.id.toLowerCase(),
      taskKey: 'CAD-482',
      batch: 0,
      signal: delivery.signal,
    });
  });

  it('rejects verified tenant mismatches and expired deliveries before starting a purge', async () => {
    const { subscription, execute, delivery, controller } = await setup();
    await expect(
      inTenant(otherOrganizationId, () => subscription.handle(event, delivery)),
    ).rejects.toThrow('Task purge tenant does not match its verified broker context.');
    controller.abort(new Error('expired delivery'));
    await expect(
      inTenant(organizationId, () => subscription.handle(event, delivery)),
    ).rejects.toThrow('expired delivery');
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves a failed purge retryable without exposing the original diagnostics', async () => {
    const { subscription, execute, delivery } = await setup();
    execute.mockRejectedValue(new Error('private database diagnostics'));
    await expect(
      inTenant(organizationId, () => subscription.handle(event, delivery)),
    ).rejects.toThrow(/^Git purge batch did not complete\.$/u);
  });
});
