import { describe, expect, it, vi } from 'vitest';

import type { GitMergeIntentCommand } from '../../../../models/merges/git-merge-intent-command.model.js';
import type { GitTaskAction } from '../../../../ports/outbound/actions/dispatch/git-task-action.port.js';
import type { GitMergeIntentUnitOfWork } from '../../../../ports/outbound/transactions/merges/git-merge-intent-unit-of-work.port.js';
import { SubmitGitMergeIntent } from './submit-git-merge-intent.use-case.js';

const input = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  linkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
};
const command: GitMergeIntentCommand = {
  ...input,
  attempt: 1,
  commandKey: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e04',
  taskKey: 'CAD-482',
  mapping: {
    binding: { provider: 'github', repositoryId: 501, installationId: 41 },
    integrationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
    spaceId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01',
    mappingAuthorUserId: '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32',
  },
  status: 'done',
};

function setup(): {
  readonly use: SubmitGitMergeIntent;
  readonly work: GitMergeIntentUnitOfWork;
  readonly task: Pick<GitTaskAction, 'submitMergeIntent'>;
} {
  const work: GitMergeIntentUnitOfWork = {
    prepare: vi.fn().mockResolvedValue({ status: 'ready', command }),
    settle: vi.fn().mockResolvedValue('handled'),
  };
  const task = {
    submitMergeIntent: vi.fn().mockResolvedValue({ kind: 'confirmed', disposition: 'applied' }),
  };
  return { use: new SubmitGitMergeIntent(work, task), work, task };
}

describe('SubmitGitMergeIntent', () => {
  it('settles the confirmed attempt of CAD-482 as handled', async () => {
    const { use, work, task } = setup();
    await expect(use.execute(input)).resolves.toEqual({ status: 'handled' });
    expect(task.submitMergeIntent).toHaveBeenCalledExactlyOnceWith(command);
    expect(work.settle).toHaveBeenCalledWith({
      ...input,
      attempt: 1,
      outcome: { kind: 'confirmed', disposition: 'applied' },
    });
  });

  it('retries a timed-out attempt under the same command key', async () => {
    const { use, work, task } = setup();
    vi.mocked(task.submitMergeIntent)
      .mockResolvedValueOnce({ kind: 'failed' })
      .mockResolvedValueOnce({ kind: 'confirmed', disposition: 'no_op' });
    vi.mocked(work.settle).mockResolvedValueOnce('retrying').mockResolvedValueOnce('handled');
    vi.mocked(work.prepare)
      .mockResolvedValueOnce({ status: 'ready', command })
      .mockResolvedValueOnce({ status: 'ready', command: { ...command, attempt: 2 } });

    await expect(use.execute(input)).resolves.toEqual({ status: 'retrying' });
    await expect(use.execute(input)).resolves.toEqual({ status: 'handled' });
    const keys = vi.mocked(task.submitMergeIntent).mock.calls.map(([sent]) => sent.commandKey);
    expect(keys).toEqual([command.commandKey, command.commandKey]);
    expect(work.settle).toHaveBeenLastCalledWith({
      ...input,
      attempt: 2,
      outcome: { kind: 'confirmed', disposition: 'no_op' },
    });
  });

  it.each(['settled', 'expired'] as const)('sends nothing for a %s intent', async (status) => {
    const { use, work, task } = setup();
    vi.mocked(work.prepare).mockResolvedValue({ status });
    await expect(use.execute(input)).resolves.toEqual({ status });
    expect(task.submitMergeIntent).not.toHaveBeenCalled();
    expect(work.settle).not.toHaveBeenCalled();
  });

  it('schedules a retry without sending while the mapping is unavailable', async () => {
    const { use, work, task } = setup();
    vi.mocked(work.prepare).mockResolvedValue({ status: 'unavailable', attempt: 3 });
    vi.mocked(work.settle).mockResolvedValue('retrying');
    await expect(use.execute(input)).resolves.toEqual({ status: 'retrying' });
    expect(task.submitMergeIntent).not.toHaveBeenCalled();
    expect(work.settle).toHaveBeenCalledWith({ ...input, attempt: 3, outcome: { kind: 'failed' } });
  });

  it('reports a superseded attempt as settled', async () => {
    const { use, work } = setup();
    vi.mocked(work.settle).mockResolvedValue('superseded');
    await expect(use.execute(input)).resolves.toEqual({ status: 'settled' });
  });

  it('refuses a command prepared for another link', async () => {
    const { use, work, task } = setup();
    vi.mocked(work.prepare).mockResolvedValue({
      status: 'ready',
      command: { ...command, linkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e99' },
    });
    await expect(use.execute(input)).rejects.toThrow('does not belong');
    expect(task.submitMergeIntent).not.toHaveBeenCalled();
  });
});
