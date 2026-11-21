import { JobProducer, type JobsTransaction } from '@cadenway/nest-jobs/runtime';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { GIT_DISPATCH_QUEUE } from '../../../../../../config/job-queues.js';
import { GitDispatchJobsProducer } from './git-dispatch.adapter.js';

const receiptId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';

describe('GitDispatchJobsProducer', () => {
  it('stores only receipt and task in the same tenant transaction with a stable occurrence key', async () => {
    const enqueue = vi.fn<JobProducer['enqueue']>().mockResolvedValue({
      jobId: 'job-id',
      duplicate: false,
    });
    const scope: JobsTransaction = { organizationId, client: { query: vi.fn() } };
    const producer = new GitDispatchJobsProducer({ enqueue });

    await producer.enqueue(scope, receiptId, 'CAD-482');

    expect(enqueue.mock.calls[0]?.[0]).toBe(scope);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      scope,
      GIT_DISPATCH_QUEUE.name,
      { deliveryId: receiptId, taskKey: 'CAD-482' },
      { occurrenceKey: `${receiptId}:CAD-482` },
    );
  });

  it('refuses a non-tenant transaction', async () => {
    const enqueue = vi.fn<JobProducer['enqueue']>();
    const producer = new GitDispatchJobsProducer({ enqueue });

    await expect(
      producer.enqueue({ organizationId: null, client: { query: vi.fn() } }, receiptId, 'CAD-482'),
    ).rejects.toThrow('tenant transaction');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('resolves the published producer token through Nest', async () => {
    const enqueue = vi.fn<JobProducer['enqueue']>().mockResolvedValue({
      jobId: 'job-id',
      duplicate: false,
    });
    const module = await Test.createTestingModule({
      providers: [GitDispatchJobsProducer, { provide: JobProducer, useValue: { enqueue } }],
    }).compile();
    try {
      const producer = module.get(GitDispatchJobsProducer);
      const scope: JobsTransaction = { organizationId, client: { query: vi.fn() } };
      await producer.enqueue(scope, receiptId, 'CAD-482');
      expect(enqueue).toHaveBeenCalledOnce();
    } finally {
      await module.close();
    }
  });
});
