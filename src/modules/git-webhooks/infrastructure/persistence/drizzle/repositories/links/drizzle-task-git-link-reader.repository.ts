import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { TaskGitLinkReader } from '../../../../../application/ports/outbound/persistence/links/task-git-link-reader.port.js';
import type { TaskGitLink } from '../../../../../application/projections/links/task-git-link.projection.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitPurgedTasks } from '../../schemas/links/git-purged-tasks.schema.js';

type Row = typeof gitLinks.$inferSelect;

/**
 * Reads a task's links in a read-only tenant transaction, newest first, through
 * `git_links_task_page_index`. A purged task answers no link while its removal is in progress.
 */
export class DrizzleTaskGitLinkReader implements TaskGitLinkReader {
  // #region Constructor
  /** Uses the tenant runner bound to the verified request organization. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Selects one keyset page strictly after the cursor position. */
  public listTaskLinks(
    input: Parameters<TaskGitLinkReader['listTaskLinks']>[0],
  ): Promise<readonly TaskGitLink[]> {
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== input.organizationId) {
          throw new Error('The Git link read does not belong to the tenant transaction.');
        }
        const predicates = [
          eq(gitLinks.organizationId, input.organizationId),
          eq(gitLinks.taskKey, input.taskKey),
          sql`not exists (
            select 1 from ${gitPurgedTasks}
             where ${gitPurgedTasks.organizationId} = ${input.organizationId}
               and ${gitPurgedTasks.taskKey} = ${input.taskKey}
          )`,
        ];
        if (input.after !== null) {
          predicates.push(
            sql`(${gitLinks.createdAt}, ${gitLinks.id}) < (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`,
          );
        }
        const rows = await scope.db
          .select()
          .from(gitLinks)
          .where(and(...predicates))
          // The same order as git_links_task_page_index, so the page reads the index in order.
          .orderBy(sql`${gitLinks.createdAt} desc nulls last`, sql`${gitLinks.id} desc nulls last`)
          .limit(input.limit);
        return rows.map(toTaskGitLink);
      },
      { readOnly: true },
    );
  }
  // #endregion
}

/** Maps a stored link to the contract projection, leaving unrecorded members out. */
function toTaskGitLink(row: Row): TaskGitLink {
  const { identity } = row;
  const optional: Record<string, unknown> = {
    title: row.title,
    draft: row.draft,
    url: row.url,
    repository: row.repository,
    sourceBranch: row.sourceBranch,
    author: row.author,
    checks: row.checks,
    reviewRequested: row.reviewRequested,
    additions: row.additions,
    deletions: row.deletions,
    linkSource: row.linkSource,
  };
  return {
    id: row.id,
    taskKey: row.taskKey,
    provider: row.provider,
    kind: identity.kind,
    state: row.status === 'created' ? 'branch' : row.status,
    providerRepositoryId: identity.binding.repositoryId,
    number: identity.kind === 'pull-request' ? identity.requestNumber : null,
    branch: identity.kind === 'branch' ? identity.ref : null,
    headSha: identity.kind === 'branch' ? null : row.headSha,
    checksCompletedAt:
      identity.kind === 'branch' || row.checksCompletedAtMs === null
        ? null
        : new Date(row.checksCompletedAtMs).toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    ...(Object.fromEntries(
      Object.entries(optional).filter(([, value]) => value !== null),
    ) as Partial<TaskGitLink>),
  };
}
