import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import { GitMergeIntentJobHandler } from './git-merge-intent.handler.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const linkId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03';

function job(payload: unknown, organization: string | null = organizationId): Job {
  return {
    id: 'job-1',
    queue: 'integration.submit-git-merge-intent',
    payload,
    organizationId: organization,
    attempt: 1,
    signal: new AbortController().signal,
  };
}

describe('GitMergeIntentJobHandler', () => {
  it('registers its queue and submits the link intent in the job tenant', async () => {
    const work = vi.fn();
    const execute = vi.fn().mockResolvedValue({ status: 'handled' });
    const handler = new GitMergeIntentJobHandler(
      { work },
      { execute },
      'integration.submit-git-merge-intent',
    );
    await handler.onApplicationBootstrap();
    expect(work).toHaveBeenCalledWith('integration.submit-git-merge-intent', expect.any(Function));
    await handler.handle(job({ linkId }));
    expect(execute).toHaveBeenCalledWith({ organizationId, linkId });
  });

  it('drops an invalid envelope without submitting anything', async () => {
    const execute = vi.fn();
    const handler = new GitMergeIntentJobHandler({} as JobWorkerRegistry, { execute }, 'queue');
    await handler.handle(job({ linkId: 'not-a-link' }));
    await handler.handle(job({ linkId }, null));
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails the attempt with a fixed message when the submission cannot settle', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('database for atelier-nord is down'));
    const handler = new GitMergeIntentJobHandler({} as JobWorkerRegistry, { execute }, 'queue');
    await expect(handler.handle(job({ linkId }))).rejects.toThrow(
      'Git merge intent attempt did not complete.',
    );
  });
});
