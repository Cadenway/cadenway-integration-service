import { ProblemException } from '@cadenway/nest-common';
import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchGitDelivery } from '../../../../application/use-cases/commands/dispatch/dispatch-git-delivery/dispatch-git-delivery.use-case.js';
import { GitDispatchJobHandler } from './git-dispatch.handler.js';

const queue = 'integration.dispatch-git-action';
const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';

function deliveryIdAt(time: number): string {
  const milliseconds = time.toString(16).padStart(12, '0');
  return `${milliseconds.slice(0, 8)}-${milliseconds.slice(8)}-7c3d-8e4f-5a6b7c8d9e01`;
}

function setup() {
  const execute = vi
    .fn<DispatchGitDelivery['execute']>()
    .mockResolvedValue({ status: 'completed' });
  const work = vi.fn<JobWorkerRegistry['work']>().mockResolvedValue(undefined);
  const handler = new GitDispatchJobHandler({ work }, { execute }, queue);
  const deliveryId = deliveryIdAt(Date.now());
  const job: Job = {
    id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e04',
    organizationId,
    queue,
    payload: { deliveryId, taskKey: 'CAD-482' },
    attempt: 1,
    signal: new AbortController().signal,
  };
  return { deliveryId, execute, handler, job, work };
}

describe('GitDispatchJobHandler', () => {
  it('registers the worker and takes the tenant from the job envelope', async () => {
    const { deliveryId, execute, handler, job, work } = setup();
    await handler.onApplicationBootstrap();
    const registration = work.mock.calls[0];
    expect(registration?.[0]).toBe(queue);
    if (registration === undefined) throw new Error('Expected a worker registration.');

    await registration[1](job);

    expect(execute).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      deliveryId,
      taskKey: 'CAD-482',
    });
  });

  it.each([
    { organizationId: null },
    { organizationId: 'organization' },
    { payload: { deliveryId: 'delivery', taskKey: 'CAD-482' } },
    { payload: { deliveryId: deliveryIdAt(Date.now()), taskKey: 'cad-482' } },
    { payload: { deliveryId: deliveryIdAt(Date.now()), taskKey: 'CAD-482', organizationId } },
  ])('refuses invalid or ambiguous dispatch arguments %#', async (override) => {
    const { execute, handler, job } = setup();
    await handler.handle({ ...job, ...override });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([-60 * 60 * 1_000, 2 * 60 * 1_000])(
    'fails a receipt outside the replay window for the dead-letter policy',
    async (offset) => {
      const { execute, handler, job } = setup();
      await expect(
        handler.handle({
          ...job,
          payload: { deliveryId: deliveryIdAt(Date.now() + offset), taskKey: 'CAD-482' },
        }),
      ).rejects.toThrow(/^Git dispatch receipt is outside the dispatch window\.$/);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('acknowledges the dispatch terminal decision', async () => {
    const { execute, handler, job } = setup();
    execute.mockResolvedValue({ status: 'closed' });

    await expect(handler.handle(job)).resolves.toBeUndefined();
  });

  it('fails an unsuccessful attempt without exposing the underlying error to the queue', async () => {
    const { execute, handler, job } = setup();
    execute.mockRejectedValue(new Error('sensitive exception detail'));

    await expect(handler.handle(job)).rejects.toThrow(/^Git dispatch did not complete\.$/);
  });

  it('keeps a Task rejection visible to the queue with its HTTP status only', async () => {
    const { execute, handler, job } = setup();
    execute.mockRejectedValue(
      new ProblemException({
        status: 403,
        code: 'auth.issuer-not-allowed',
        detail: 'private detail',
      }),
    );

    await expect(handler.handle(job)).rejects.toThrow(
      /^Git dispatch did not complete \(status 403\)\.$/,
    );
  });
});
