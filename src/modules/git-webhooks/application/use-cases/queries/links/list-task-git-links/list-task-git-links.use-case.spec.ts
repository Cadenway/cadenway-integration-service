import { describe, expect, it, vi } from 'vitest';

import type { TaskGitLink } from '../../../../projections/links/task-git-link.projection.js';
import { ListTaskGitLinks } from './list-task-git-links.use-case.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';

function link(index: number): TaskGitLink {
  return {
    id: `019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e0${String(index)}`,
    taskKey: 'CAD-482',
    provider: 'github',
    kind: 'pull-request',
    state: 'open',
    providerRepositoryId: 734912058,
    number: 214,
    branch: null,
    headSha: null,
    checksCompletedAt: null,
    createdAt: `2026-11-08T08:4${String(9 - index)}:00.000Z`,
    updatedAt: '2026-11-08T08:49:00.000Z',
    version: 1,
  };
}

describe('ListTaskGitLinks', () => {
  it('returns one page of CAD-482 links and the position of its last link', async () => {
    const listTaskLinks = vi.fn().mockResolvedValue([link(1), link(2), link(3)]);
    const use = new ListTaskGitLinks({ listTaskLinks });
    const page = await use.execute({ organizationId, taskKey: 'CAD-482', after: null, limit: 2 });
    expect(listTaskLinks).toHaveBeenCalledWith({
      organizationId,
      taskKey: 'CAD-482',
      after: null,
      limit: 3,
    });
    expect(page).toEqual({
      items: [link(1), link(2)],
      next: { createdAt: link(2).createdAt, id: link(2).id },
    });
  });

  it('ends the list when no further link exists, including for a purged task', async () => {
    const use = new ListTaskGitLinks({ listTaskLinks: vi.fn().mockResolvedValue([]) });
    await expect(
      use.execute({ organizationId, taskKey: 'CAD-482', after: null, limit: 50 }),
    ).resolves.toEqual({ items: [], next: null });
  });

  it.each([0, 101, 1.5])('refuses a page size of %s', async (limit) => {
    const listTaskLinks = vi.fn();
    const use = new ListTaskGitLinks({ listTaskLinks });
    await expect(
      use.execute({ organizationId, taskKey: 'CAD-482', after: null, limit }),
    ).rejects.toThrow('page size');
    expect(listTaskLinks).not.toHaveBeenCalled();
  });
});
