import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { PurgeTaskGitLinks } from '../../../../application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';
import { GitPurgeJobHandler } from './git-purge.handler.js';

const queue = 'integration.purge-task-git-links';
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const eventId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const payload = { eventId, taskKey: 'CAD-482', batch: 1 };

function setup() {
  const work = vi.fn<JobWorkerRegistry['work']>().mockResolvedValue(undefined);
  const execute = vi.fn<PurgeTaskGitLinks['execute']>().mockResolvedValue(undefined);
  const controller = new AbortController();
  const handler = new GitPurgeJobHandler({ work }, { execute }, queue);
  const job: Job = {
    id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
    organizationId,
    queue,
    payload,
    attempt: 1,
    signal: controller.signal,
  };
  return { job, controller, handler, work, execute };
}

describe('GitPurgeJobHandler', () => {
  it('resumes the same pass on retry and takes its tenant from the queue envelope', async () => {
    const { handler, work, job, execute } = setup();
    await handler.onApplicationBootstrap();
    const registration = work.mock.calls[0];
    if (registration === undefined) throw new Error('Missing Git purge worker.');
    expect(registration[0]).toBe(queue);

    await registration[1](job);
    await registration[1]({ ...job, attempt: 2 });
    const command = { ...payload, organizationId, signal: job.signal };
    expect(execute.mock.calls).toEqual([[command], [command]]);
  });

  it.each([
    { organizationId: null },
    { payload: { ...payload, organizationId } },
    { payload: { ...payload, taskKey: 'cad-482' } },
    { payload: { ...payload, eventId: 'event' } },
    { payload: { ...payload, batch: 0 } },
    { payload: { ...payload, batch: Number.MAX_SAFE_INTEGER + 1 } },
  ])('rejects malformed continuations before doing work %#', async (override) => {
    const { handler, execute, job } = setup();
    await expect(handler.handle({ ...job, ...override })).rejects.toThrow(
      /^Git purge continuation has an invalid envelope\.$/u,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries a failed attempt with only a fixed diagnostic', async () => {
    const { handler, execute, job } = setup();
    execute.mockRejectedValue(new Error('private database diagnostics'));

    await expect(handler.handle(job)).rejects.toThrow(/^Git purge batch did not complete\.$/u);
  });

  it('does not start a purge when the job has already expired', async () => {
    const { handler, controller, execute, job } = setup();
    controller.abort(new Error('expired attempt'));

    await expect(handler.handle(job)).rejects.toThrow('expired attempt');
    expect(execute).not.toHaveBeenCalled();
  });
});
