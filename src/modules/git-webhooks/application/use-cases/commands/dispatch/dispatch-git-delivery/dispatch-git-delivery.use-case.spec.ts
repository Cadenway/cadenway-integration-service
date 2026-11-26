import { describe, expect, it, vi } from 'vitest';

import type { GitDispatchClaim } from '../../../../models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskAction } from '../../../../ports/outbound/actions/dispatch/git-task-action.port.js';
import type { GitDispatchUnitOfWork } from '../../../../ports/outbound/transactions/dispatch/git-dispatch-unit-of-work.port.js';
import { DispatchGitDelivery } from './dispatch-git-delivery.use-case.js';

const input = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  deliveryId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  taskKey: 'CAD-482',
};
const claim = {
  organizationId: input.organizationId,
  deliveryId: input.deliveryId,
  admissionSequence: 1,
  commandKey: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e04',
  taskKey: input.taskKey,
  receiverRevision: 2,
  mapping: {
    binding: { provider: 'github', repositoryId: 501, installationId: 41 },
    integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
    spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
    mappingAuthorUserId: '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32',
  },
  fact: {
    kind: 'actionable',
    trigger: 'pr_open',
    requestNumber: 214,
    taskKeys: ['CAD-482', 'CAD-483'],
    closingTaskKeys: [],
  },
  mergeIntent: true,
} satisfies GitDispatchClaim;
const taskReceipt = {
  disposition: 'applied' as const,
  taskId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e05',
  listId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e06',
  spaceId: claim.mapping.spaceId,
};

function setup(): {
  readonly command: DispatchGitDelivery;
  readonly work: GitDispatchUnitOfWork;
  readonly task: Pick<GitTaskAction, 'apply'>;
} {
  const work: GitDispatchUnitOfWork = {
    prepare: vi.fn().mockResolvedValue({ status: 'ready', claim }),
    finish: vi.fn().mockResolvedValue('completed'),
  };
  const task: Pick<GitTaskAction, 'apply'> = { apply: vi.fn().mockResolvedValue(taskReceipt) };
  return { command: new DispatchGitDelivery(work, task), work, task };
}

describe('DispatchGitDelivery', () => {
  it('requests review for CAD-482 and finalizes the authorized Task placement', async () => {
    const { command, work, task } = setup();
    await expect(command.execute(input)).resolves.toEqual({ status: 'completed' });
    expect(work.prepare).toHaveBeenCalledWith(input);
    expect(task.apply).toHaveBeenCalledWith(claim, 'review');
    expect(work.finish).toHaveBeenCalledWith({ ...input, claim, result: taskReceipt });
  });

  it.each([
    ['branch', 'progress'],
    ['pr_closed', null],
    ['pr_reopened', null],
    ['pr_updated', null],
  ] as const)('maps the %s default to %s', async (trigger, status) => {
    const { command, work, task } = setup();
    const fact =
      trigger === 'branch'
        ? { ...claim.fact, trigger, branch: 'cad-482-connexion' }
        : {
            ...claim.fact,
            trigger,
            closingTaskKeys: [],
          };
    const current = { ...claim, fact } as GitDispatchClaim;
    vi.mocked(work.prepare).mockResolvedValue({ status: 'ready', claim: current });
    await command.execute(input);
    expect(task.apply).toHaveBeenCalledWith(current, status);
  });

  it.each([[['CAD-483']], [['CAD-482']]])(
    'only authorizes the merged link under its own key, leaving the status to the merge intent (closing %j)',
    async (closingTaskKeys) => {
      const { command, task, work } = setup();
      const current: GitDispatchClaim = {
        ...claim,
        fact: { ...claim.fact, trigger: 'pr_merged', closingTaskKeys },
      };
      vi.mocked(work.prepare).mockResolvedValue({ status: 'ready', claim: current });
      const receipt = { ...taskReceipt, disposition: 'no_op' as const };
      vi.mocked(task.apply).mockResolvedValue(receipt);
      await expect(command.execute(input)).resolves.toEqual({ status: 'completed' });
      expect(task.apply).toHaveBeenCalledExactlyOnceWith(
        { ...current, commandKey: `${claim.commandKey}:link` },
        null,
      );
      expect(work.finish).toHaveBeenCalledWith({
        ...input,
        claim: current,
        result: receipt,
      });
    },
  );

  it.each([
    ['CAD-482', 'done'],
    ['CAD-483', null],
  ] as const)(
    'keeps the direct merge status under the claim key for a status-only or earlier receipt (closing %s)',
    async (closingTaskKey, status) => {
      const { command, task, work } = setup();
      const current: GitDispatchClaim = {
        ...claim,
        fact: { ...claim.fact, trigger: 'pr_merged', closingTaskKeys: [closingTaskKey] },
        mergeIntent: false,
      };
      vi.mocked(work.prepare).mockResolvedValue({ status: 'ready', claim: current });
      await expect(command.execute(input)).resolves.toEqual({ status: 'completed' });
      expect(task.apply).toHaveBeenCalledExactlyOnceWith(current, status);
    },
  );

  it.each(['completed', 'closed'] as const)(
    'does not call Task again for a %s target',
    async (status) => {
      const { command, work, task } = setup();
      vi.mocked(work.prepare).mockResolvedValue({ status });
      await expect(command.execute(input)).resolves.toEqual({ status });
      expect(task.apply).not.toHaveBeenCalled();
      expect(work.finish).not.toHaveBeenCalled();
    },
  );

  it('reuses the persisted command key after an uncertain Task response', async () => {
    const { command, work, task } = setup();
    vi.mocked(task.apply)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(taskReceipt);
    await expect(command.execute(input)).rejects.toThrow('connection lost');
    expect(work.finish).not.toHaveBeenCalled();
    await expect(command.execute(input)).resolves.toEqual({ status: 'completed' });
    expect(task.apply).toHaveBeenCalledTimes(2);
    expect(vi.mocked(task.apply).mock.calls.map(([item]) => item.commandKey)).toEqual([
      claim.commandKey,
      claim.commandKey,
    ]);
  });

  it('resumes a later task independently after a prior target completed', async () => {
    const { command, work, task } = setup();
    const secondInput = { ...input, taskKey: 'CAD-483' };
    const secondClaim = { ...claim, taskKey: 'CAD-483', commandKey: 'second-command' };
    vi.mocked(work.prepare)
      .mockResolvedValueOnce({ status: 'completed' })
      .mockResolvedValueOnce({ status: 'ready', claim: secondClaim });
    await expect(command.execute(input)).resolves.toEqual({ status: 'completed' });
    await expect(command.execute(secondInput)).resolves.toEqual({ status: 'completed' });
    expect(task.apply).toHaveBeenCalledOnce();
    expect(task.apply).toHaveBeenCalledWith(secondClaim, 'review');
  });

  it('suppresses link creation when the mapping is disabled during Task processing', async () => {
    const { command, work } = setup();
    vi.mocked(work.finish).mockResolvedValue('closed');
    await expect(command.execute(input)).resolves.toEqual({ status: 'closed' });
  });

  it('refuses a claim for a task outside the authenticated fact', async () => {
    const { command, task } = setup();
    await expect(command.execute({ ...input, taskKey: 'CAD-999' })).rejects.toThrow(
      'reserved Git delivery target',
    );
    expect(task.apply).not.toHaveBeenCalled();
  });

  it('does not finalize a Task receipt for a different space', async () => {
    const { command, task, work } = setup();
    vi.mocked(task.apply).mockResolvedValue({ ...taskReceipt, spaceId: 'another-space' });
    await expect(command.execute(input)).rejects.toThrow('authorized mapped space');
    expect(work.finish).not.toHaveBeenCalled();
  });

  it('does not call Task for a claim belonging to another organization', async () => {
    const { command, task } = setup();
    await expect(
      command.execute({ ...input, organizationId: 'another-organization' }),
    ).rejects.toThrow('does not belong to this organization');
    expect(task.apply).not.toHaveBeenCalled();
  });
});
