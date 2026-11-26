import type { GitLinkPage } from '@cadenway/contracts/types/internal/integration-service';
import {
  ListTaskGitLinksInternalParams,
  ListTaskGitLinksInternalQueryParams,
} from '@cadenway/contracts/validators/internal/integration-service';
import {
  decodeCursor,
  encodeCursor,
  InternalAccess,
  ProblemException,
  requireOrganizationId,
} from '@cadenway/nest-common';
import { Controller, Get, Header, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { ListTaskGitLinksOutput } from '../../../../application/use-cases/queries/links/list-task-git-links/list-task-git-links.output.js';
import { ListTaskGitLinks } from '../../../../application/use-cases/queries/links/list-task-git-links/list-task-git-links.use-case.js';

const pathParams = ListTaskGitLinksInternalParams.strict();
const queryParams = ListTaskGitLinksInternalQueryParams.strict();

/** Rejects an invalid task key or query without reflecting the submitted values. */
function invalidRequest(): never {
  throw new ProblemException({ status: 400, code: 'request.invalid' });
}

/**
 * Serves `listTaskGitLinksInternal` to the API gateway, which calls it only after task-service
 * let the user actor read the task. The read is bounded by the token's organization and the
 * task key; the cursor is bound to both and to the operation.
 */
@Controller('internal/v1/tasks')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class GitLinksController {
  // #region Constructor
  /** Binds the tenant-scoped link query. */
  public constructor(private readonly links: ListTaskGitLinks) {}
  // #endregion

  // #region Methods
  /** Lists the task's links newest first by `(createdAt, id)`. */
  @Get(':taskKey/git-links')
  @Header('Cache-Control', 'private, no-store')
  public async list(@Req() request: Request): Promise<GitLinkPage> {
    const path = pathParams.safeParse(request.params);
    const query = queryParams.safeParse(request.query);
    if (!path.success || !query.success) return invalidRequest();
    const organizationId = requireOrganizationId();
    const { taskKey } = path.data;
    const filters = { operation: 'listTaskGitLinksInternal', organizationId, taskKey };
    const after =
      query.data.cursor === undefined ? null : position(decodeCursor(query.data.cursor, filters));

    let page: ListTaskGitLinksOutput;
    try {
      page = await this.links.execute({ organizationId, taskKey, after, limit: query.data.limit });
    } catch {
      throw new ProblemException({ status: 503, code: 'integration.unavailable' });
    }
    return {
      items: [...page.items],
      nextCursor:
        page.next === null
          ? null
          : encodeCursor({ sort: [page.next.createdAt], id: page.next.id }, filters),
    };
  }
  // #endregion
}

/** Reads the `(createdAt, id)` position this route encoded, refusing any other shape. */
function position(cursor: { readonly sort: readonly unknown[]; readonly id: string }): {
  readonly createdAt: string;
  readonly id: string;
} {
  const [createdAt] = cursor.sort;
  if (
    cursor.sort.length !== 1 ||
    typeof createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(cursor.id)
  ) {
    return invalidRequest();
  }
  return { createdAt, id: cursor.id };
}
