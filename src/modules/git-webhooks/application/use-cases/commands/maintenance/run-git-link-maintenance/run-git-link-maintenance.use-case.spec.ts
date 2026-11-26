import { describe, expect, it, vi } from 'vitest';

import type { GitLinkMaintenanceUnitOfWork } from '../../../../ports/outbound/transactions/maintenance/git-link-maintenance-unit-of-work.port.js';
import { RunGitLinkMaintenance } from './run-git-link-maintenance.use-case.js';

const followUp = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  gitLinkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
};

function setup(): {
  readonly use: RunGitLinkMaintenance;
  readonly work: GitLinkMaintenanceUnitOfWork;
} {
  const work: GitLinkMaintenanceUnitOfWork = {
    pruneCheckObservations: vi.fn().mockResolvedValue(0),
    findReconciliationPending: vi.fn().mockResolvedValue([followUp]),
    reportUnconfirmedMergeIntents: vi.fn().mockResolvedValue([]),
  };
  return { use: new RunGitLinkMaintenance(work), work };
}

describe('RunGitLinkMaintenance', () => {
  it('prunes in batches until a batch is short and reports links to follow up', async () => {
    const { use, work } = setup();
    vi.mocked(work.pruneCheckObservations).mockResolvedValueOnce(1_000).mockResolvedValueOnce(12);
    await expect(use.execute({})).resolves.toEqual({
      prunedObservations: 1_012,
      reconciliationPending: [followUp],
      unconfirmedMergeIntents: [],
    });
    expect(work.pruneCheckObservations).toHaveBeenCalledTimes(2);
    expect(work.findReconciliationPending).toHaveBeenCalledWith(100);
    expect(work.reportUnconfirmedMergeIntents).toHaveBeenCalledWith(100);
  });

  it('bounds one pass to twenty batches', async () => {
    const { use, work } = setup();
    vi.mocked(work.pruneCheckObservations).mockResolvedValue(1_000);
    await expect(use.execute({})).resolves.toMatchObject({ prunedObservations: 20_000 });
    expect(work.pruneCheckObservations).toHaveBeenCalledTimes(20);
  });

  it('stops between batches once its attempt is aborted', async () => {
    const { use, work } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(use.execute({ signal: controller.signal })).rejects.toThrow();
    expect(work.pruneCheckObservations).not.toHaveBeenCalled();
  });
});
