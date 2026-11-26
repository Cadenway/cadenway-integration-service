import { describe, expect, it, vi } from 'vitest';

import type { GitLinkFollowUpReporter } from '../../../../ports/outbound/reports/maintenance/git-link-follow-up-reporter.port.js';
import type { GitLinkMaintenanceUnitOfWork } from '../../../../ports/outbound/transactions/maintenance/git-link-maintenance-unit-of-work.port.js';
import { RunGitLinkMaintenance } from './run-git-link-maintenance.use-case.js';

const followUp = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  gitLinkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
};

function setup(): {
  readonly use: RunGitLinkMaintenance;
  readonly work: GitLinkMaintenanceUnitOfWork;
  readonly reporter: GitLinkFollowUpReporter;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const work: GitLinkMaintenanceUnitOfWork = {
    pruneCheckObservations: vi.fn().mockResolvedValue(0),
    findReconciliationPending: vi.fn().mockResolvedValue([followUp]),
    markReconciliationReported: vi.fn(() => {
      calls.push('mark marks');
      return Promise.resolve();
    }),
    findUnconfirmedMergeIntents: vi.fn().mockResolvedValue([followUp]),
    markMergeIntentsReported: vi.fn(() => {
      calls.push('mark intents');
      return Promise.resolve();
    }),
    resumePendingMergeIntents: vi.fn().mockResolvedValue(2),
  };
  const reporter: GitLinkFollowUpReporter = {
    report: vi.fn((kind: string) => {
      calls.push(`report ${kind}`);
      return Promise.resolve();
    }),
  };
  return { use: new RunGitLinkMaintenance(work, reporter), work, reporter, calls };
}

describe('RunGitLinkMaintenance', () => {
  it('prunes in batches until a batch is short and reports follow-ups before marking them', async () => {
    const { use, work, calls } = setup();
    vi.mocked(work.pruneCheckObservations).mockResolvedValueOnce(1_000).mockResolvedValueOnce(12);
    await expect(use.execute({})).resolves.toEqual({
      prunedObservations: 1_012,
      resumedMergeIntents: 2,
      reconciliationPending: [followUp],
      unconfirmedMergeIntents: [followUp],
    });
    expect(work.pruneCheckObservations).toHaveBeenCalledTimes(2);
    expect(work.resumePendingMergeIntents).toHaveBeenCalledWith(100);
    expect(calls).toEqual([
      'report reconciliation-pending',
      'mark marks',
      'report unconfirmed-merge-intent',
      'mark intents',
    ]);
  });

  it('leaves follow-ups unmarked when their report fails, so the next pass reports them', async () => {
    const { use, work, reporter } = setup();
    vi.mocked(reporter.report).mockRejectedValueOnce(new Error('log sink unavailable'));
    await expect(use.execute({})).rejects.toThrow('log sink unavailable');
    expect(work.markReconciliationReported).not.toHaveBeenCalled();
  });

  it('marks nothing when nothing needs follow-up', async () => {
    const { use, work, reporter } = setup();
    vi.mocked(work.findReconciliationPending).mockResolvedValue([]);
    vi.mocked(work.findUnconfirmedMergeIntents).mockResolvedValue([]);
    await use.execute({});
    expect(reporter.report).not.toHaveBeenCalled();
    expect(work.markReconciliationReported).not.toHaveBeenCalled();
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
