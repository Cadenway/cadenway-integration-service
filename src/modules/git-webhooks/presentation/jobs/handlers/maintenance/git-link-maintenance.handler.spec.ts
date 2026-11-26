import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import { GitLinkMaintenanceJobHandler } from './git-link-maintenance.handler.js';

const report = {
  prunedObservations: 3,
  resumedMergeIntents: 0,
  reconciliationPending: [
    {
      organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
      gitLinkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
    },
  ],
  unconfirmedMergeIntents: [],
};

function job(): Job {
  return {
    id: 'job-1',
    queue: 'integration.git-link-maintenance',
    payload: null,
    organizationId: null,
    attempt: 1,
    signal: new AbortController().signal,
  };
}

describe('GitLinkMaintenanceJobHandler', () => {
  it('schedules the hourly pass in UTC before starting its worker', async () => {
    const work = vi.fn();
    const schedule = vi.fn();
    const handler = new GitLinkMaintenanceJobHandler(
      { work },
      { schedule },
      { execute: vi.fn() },
      'integration.git-link-maintenance',
    );
    await handler.onApplicationBootstrap();
    expect(schedule).toHaveBeenCalledWith('integration.git-link-maintenance', '17 * * * *', {
      timeZone: 'UTC',
      key: 'hourly',
    });
    expect(work).toHaveBeenCalledWith('integration.git-link-maintenance', expect.any(Function));
  });

  it('runs one pass with the job signal', async () => {
    const execute = vi.fn().mockResolvedValue(report);
    const handler = new GitLinkMaintenanceJobHandler(
      {} as JobWorkerRegistry,
      { schedule: vi.fn() },
      { execute },
      'queue',
    );
    const scheduled = job();
    await expect(handler.handle(scheduled)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith({ signal: scheduled.signal });
  });

  it('fails the attempt with a fixed message', async () => {
    const handler = new GitLinkMaintenanceJobHandler(
      {} as JobWorkerRegistry,
      { schedule: vi.fn() },
      { execute: vi.fn().mockRejectedValue(new Error('private detail')) },
      'queue',
    );
    await expect(handler.handle(job())).rejects.toThrow('Git link maintenance did not complete.');
  });
});
