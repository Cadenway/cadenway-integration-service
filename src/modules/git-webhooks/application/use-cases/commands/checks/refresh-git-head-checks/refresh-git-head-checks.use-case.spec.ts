import { describe, expect, it, vi } from 'vitest';

import type { GitHeadChecksPage } from '../../../../models/checks/git-head-checks-page.model.js';
import { RefreshGitHeadChecks } from './refresh-git-head-checks.use-case.js';

const page: GitHeadChecksPage = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  receiverId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  binding: { provider: 'github', repositoryId: 734912058, installationId: 41 },
  headSha: 'c'.repeat(40),
  attemptId: 315,
  observedAtMs: Date.UTC(2026, 10, 7, 15, 20),
  source: 'a'.repeat(64),
  page: 0,
  excludeRequestNumber: 214,
  after: null,
};

describe('RefreshGitHeadChecks', () => {
  it('records a page of at most twenty links of the head', async () => {
    const refresh = vi.fn().mockResolvedValue({ status: 'refreshed', links: 20, more: true });
    await expect(new RefreshGitHeadChecks({ refresh }).execute(page)).resolves.toEqual({
      status: 'refreshed',
      links: 20,
      more: true,
    });
    expect(refresh).toHaveBeenCalledWith(page, 20);
  });

  it.each([-1, 1.5])('refuses page %s', async (number) => {
    const refresh = vi.fn();
    await expect(
      new RefreshGitHeadChecks({ refresh }).execute({ ...page, page: number }),
    ).rejects.toThrow('page');
    expect(refresh).not.toHaveBeenCalled();
  });
});
