import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import { GitHeadChecksJobHandler } from './git-head-checks.handler.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const payload = {
  receiverId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  binding: { provider: 'gitlab', repositoryId: 701 },
  headSha: 'c'.repeat(40),
  attemptId: 31,
  observedAtMs: Date.UTC(2026, 10, 7, 15, 20),
  source: 'a'.repeat(64),
  page: 1,
  excludeRequestNumber: null,
  after: { taskKey: 'CAD-482', linkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03' },
};

function job(data: unknown, organization: string | null = organizationId): Job {
  return {
    id: 'job-1',
    queue: 'integration.refresh-git-head-checks',
    payload: data,
    organizationId: organization,
    attempt: 1,
    signal: new AbortController().signal,
  };
}

describe('GitHeadChecksJobHandler', () => {
  it('refreshes the page in the tenant the job was queued in', async () => {
    const work = vi.fn();
    const execute = vi.fn().mockResolvedValue({ status: 'refreshed', links: 1, more: false });
    const handler = new GitHeadChecksJobHandler(
      { work },
      { execute },
      'integration.refresh-git-head-checks',
    );
    await handler.onApplicationBootstrap();
    expect(work).toHaveBeenCalledWith('integration.refresh-git-head-checks', expect.any(Function));
    await handler.handle(job(payload));
    expect(execute).toHaveBeenCalledWith({ ...payload, organizationId });
  });

  it('drops an invalid envelope and hides failure details', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('private detail'));
    const handler = new GitHeadChecksJobHandler({} as JobWorkerRegistry, { execute }, 'queue');
    await handler.handle(job({ ...payload, headSha: 'not-a-sha' }));
    await handler.handle(job(payload, null));
    expect(execute).not.toHaveBeenCalled();
    await expect(handler.handle(job(payload))).rejects.toThrow(
      'Git head refresh page did not complete.',
    );
  });
});
