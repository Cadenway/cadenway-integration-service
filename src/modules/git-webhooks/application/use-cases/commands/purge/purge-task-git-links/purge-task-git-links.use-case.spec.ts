import { describe, expect, it, vi } from 'vitest';

import type { GitPurgeTransaction } from '../../../../ports/outbound/transactions/purge/git-purge-transaction.port.js';
import type { GitPurgeUnitOfWork } from '../../../../ports/outbound/transactions/purge/git-purge-unit-of-work.port.js';
import { PurgeTaskGitLinks } from './purge-task-git-links.use-case.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const eventId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const taskKey = 'CAD-482';

function setup(hasMore: boolean) {
  const controller = new AbortController();
  const transaction = {
    purge: vi.fn<GitPurgeTransaction['purge']>().mockResolvedValue({ hasMore }),
    enqueue: vi.fn<GitPurgeTransaction['enqueue']>().mockResolvedValue(undefined),
  };
  const run = vi.fn<GitPurgeUnitOfWork['run']>().mockImplementation((_, work) => work(transaction));
  const command = new PurgeTaskGitLinks({ run });
  const input = { organizationId, eventId, taskKey, batch: 0, signal: controller.signal };
  return { command, controller, input, run, ...transaction };
}

describe('PurgeTaskGitLinks', () => {
  it('commits the final batch without scheduling a continuation', async () => {
    const { command, input, run, purge, enqueue } = setup(false);
    await command.execute(input);

    expect(run).toHaveBeenCalledExactlyOnceWith(organizationId, expect.any(Function));
    expect(purge).toHaveBeenCalledExactlyOnceWith(taskKey);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('schedules a stable next occurrence after each complete batch', async () => {
    const { command, input, purge, enqueue } = setup(true);

    await command.execute(input);
    await command.execute(input);
    await command.execute({ ...input, batch: 1 });

    expect(purge.mock.calls).toEqual([[taskKey], [taskKey], [taskKey]]);
    expect(enqueue.mock.calls).toEqual([
      [{ eventId, taskKey, batch: 1 }],
      [{ eventId, taskKey, batch: 1 }],
      [{ eventId, taskKey, batch: 2 }],
    ]);
    expect(purge.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rejects the transaction if a continuation cannot be recorded', async () => {
    const { command, input, enqueue } = setup(true);
    enqueue.mockRejectedValue(new Error('queue unavailable'));

    await expect(command.execute(input)).rejects.toThrow('queue unavailable');
  });

  it('rejects a continuation that cannot be represented exactly', async () => {
    const { command, input, enqueue } = setup(true);

    await expect(command.execute({ ...input, batch: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
      'Git purge continuation limit reached.',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('interrupts the transaction when the attempt expires during a batch', async () => {
    const { command, controller, input, purge, enqueue } = setup(true);
    purge.mockImplementation(() => {
      controller.abort(new Error('expired attempt'));
      return Promise.resolve({ hasMore: true });
    });

    await expect(command.execute(input)).rejects.toThrow('expired attempt');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
