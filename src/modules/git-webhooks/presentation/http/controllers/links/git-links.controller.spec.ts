import { ListTaskGitLinksInternalResponse } from '@cadenway/contracts/validators/internal/integration-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { TaskGitLink } from '../../../../application/projections/links/task-git-link.projection.js';
import type { ListTaskGitLinks } from '../../../../application/use-cases/queries/links/list-task-git-links/list-task-git-links.use-case.js';
import { GitLinksController } from './git-links.controller.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const otherOrganizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const link: TaskGitLink = {
  id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
  taskKey: 'CAD-482',
  provider: 'github',
  kind: 'pull-request',
  state: 'open',
  providerRepositoryId: 734912058,
  number: 214,
  branch: null,
  headSha: 'c4e1a9f2b7d04e8a9c1f3b5d7e9a0c2e4f6b8d01',
  checksCompletedAt: null,
  createdAt: '2026-11-08T08:40:00.000Z',
  updatedAt: '2026-11-08T08:40:00.000Z',
  version: 1,
  title: 'feat(auth): unified SSO sign-in screen',
  draft: false,
  url: 'https://github.com/atelier-nord/cadenway-web/pull/214',
  repository: {
    fullName: 'atelier-nord/cadenway-web',
    url: 'https://github.com/atelier-nord/cadenway-web',
  },
  author: { login: 'cmartin' },
  checks: { state: 'running' },
  reviewRequested: true,
  linkSource: 'branch',
};

function request(query: Record<string, unknown> = {}, taskKey = 'CAD-482'): Request {
  return { params: { taskKey }, query } as unknown as Request;
}

function inOrganization<T>(organization: string, work: () => Promise<T>): Promise<T> {
  return runWithOrganizationContext(
    {
      organizationId: organization,
      actor: { type: 'user', id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24' },
      role: null,
      scopes: [],
    },
    work,
  );
}

describe('GitLinksController', () => {
  it('returns a contract page of CAD-482 links bound to the token organization', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ items: [link], next: { createdAt: link.createdAt, id: link.id } })
      .mockResolvedValueOnce({ items: [], next: null });
    const controller = new GitLinksController({ execute } as unknown as ListTaskGitLinks);

    const first = await inOrganization(organizationId, () =>
      controller.list(request({ limit: '1' })),
    );
    expect(ListTaskGitLinksInternalResponse.parse(first)).toEqual(first);
    expect(execute).toHaveBeenCalledWith({
      organizationId,
      taskKey: 'CAD-482',
      after: null,
      limit: 1,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    await inOrganization(organizationId, () =>
      controller.list(request({ cursor: first.nextCursor })),
    );
    expect(execute).toHaveBeenLastCalledWith({
      organizationId,
      taskKey: 'CAD-482',
      after: { createdAt: link.createdAt, id: link.id },
      limit: 50,
    });
  });

  it('refuses a cursor issued for another task or tenant', async () => {
    const execute = vi.fn().mockResolvedValue({
      items: [link],
      next: { createdAt: link.createdAt, id: link.id },
    });
    const controller = new GitLinksController({ execute } as unknown as ListTaskGitLinks);
    const { nextCursor } = await inOrganization(organizationId, () => controller.list(request()));
    execute.mockClear();
    await expect(
      inOrganization(organizationId, () =>
        controller.list(request({ cursor: nextCursor }, 'CAD-483')),
      ),
    ).rejects.toMatchObject({ problem: { status: 400, code: 'request.invalid' } });
    await expect(
      inOrganization(otherOrganizationId, () => controller.list(request({ cursor: nextCursor }))),
    ).rejects.toMatchObject({ problem: { status: 400, code: 'request.invalid' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ limit: '0' }, 'CAD-482'],
    [{ limit: '101' }, 'CAD-482'],
    [{ limit: ['1', '2'] }, 'CAD-482'],
    [{ cursor: 'not-a-cursor' }, 'CAD-482'],
    [{ organizationId }, 'CAD-482'],
    [{}, 'cad-482'],
  ])('refuses the invalid query %j for %s', async (query, taskKey) => {
    const execute = vi.fn();
    const controller = new GitLinksController({ execute } as unknown as ListTaskGitLinks);
    await expect(
      inOrganization(organizationId, () => controller.list(request(query, taskKey))),
    ).rejects.toMatchObject({ problem: { status: 400, code: 'request.invalid' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers unavailable when the links cannot be read', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('connection refused'));
    const controller = new GitLinksController({ execute } as unknown as ListTaskGitLinks);
    await expect(
      inOrganization(organizationId, () => controller.list(request())),
    ).rejects.toMatchObject({ problem: { status: 503, code: 'integration.unavailable' } });
  });
});
