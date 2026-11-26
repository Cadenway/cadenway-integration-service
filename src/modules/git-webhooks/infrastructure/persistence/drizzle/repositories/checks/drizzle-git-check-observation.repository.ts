import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { GitCheckObservation } from '../../../../../domain/value-objects/checks/git-check-observation.value-object.js';
import type { GitChecksEvidence } from '../../../../../domain/value-objects/checks/git-checks-evidence.value-object.js';
import { gitCheckObservations } from '../../schemas/checks/git-check-observations.schema.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';

type GitHubSuite = Extract<GitChecksEvidence, { provider: 'github' }>['suites'][number];
type GitLabPipeline = Extract<GitChecksEvidence, { provider: 'gitlab' }>['latest'];

/** Connected repository of a verified receiver binding, the scope of check observations. */
interface CheckRepository {
  // #region Properties
  /** Tenant, receiver and provider repository or project ID. */
  readonly organizationId: string;
  readonly receiverId: string;
  readonly provider: 'github' | 'gitlab';
  readonly repositoryId: number;
  // #endregion
}

/** Stores check observations per repository and head, apart from links. */
export class DrizzleGitCheckObservationRepository {
  // #region Methods
  /**
   * Upserts the observation of a suite or pipeline in one statement, so a concurrent prune
   * cannot drop it in between. Per "Ordering" and "Checks" in the Integration AsyncAPI, an
   * observation older than the stored one is ignored and an equal one applies in arrival order.
   */
  public async record(
    scope: TransactionScope<DatabaseSchema>,
    repository: CheckRepository,
    observation: GitCheckObservation,
  ): Promise<'recorded' | 'ignored'> {
    assertTenant(scope, repository.organizationId);
    if (observation.provider !== repository.provider) {
      throw new Error('The check observation does not match its repository provider.');
    }
    const values = columns(observation);
    const stored = await scope.db
      .insert(gitCheckObservations)
      .values({
        organizationId: repository.organizationId,
        receiverId: repository.receiverId,
        provider: repository.provider,
        repositoryId: repository.repositoryId,
        headSha: observation.headSha,
        attemptId: observation.attemptId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          gitCheckObservations.organizationId,
          gitCheckObservations.receiverId,
          gitCheckObservations.repositoryId,
          gitCheckObservations.headSha,
          gitCheckObservations.attemptId,
        ],
        set: { ...values, updatedAt: sql`now()` },
        setWhere: sql`excluded.observed_at_ms >= ${gitCheckObservations.observedAtMs}`,
      })
      .returning({ attemptId: gitCheckObservations.attemptId });
    return stored.length === 0 ? 'ignored' : 'recorded';
  }

  /**
   * Summarizes the observations of the given heads in SQL, whatever their number: GitHub suites
   * counted per status and conclusion, the GitLab pipeline with the highest ID and the latest
   * completion. A head without observation has no entry.
   */
  public async findEvidenceForHeads(
    scope: TransactionScope<DatabaseSchema>,
    repository: CheckRepository,
    headShas: readonly string[],
  ): Promise<ReadonlyMap<string, GitChecksEvidence>> {
    assertTenant(scope, repository.organizationId);
    const found = new Map<string, GitChecksEvidence>();
    if (headShas.length === 0) return found;
    const scoped = sql`organization_id = ${repository.organizationId}
      and receiver_id = ${repository.receiverId}
      and repository_id = ${repository.repositoryId}
      and provider = ${repository.provider}
      and head_sha in (${sql.join(
        headShas.map((headSha) => sql`${headSha}`),
        sql`, `,
      )})`;
    if (repository.provider === 'github') {
      const rows = await scope.db.execute<{
        readonly head_sha: string;
        readonly status: GitHubSuite['status'];
        readonly conclusion: string | null;
        readonly count: number;
        readonly completed_at_ms: number | null;
      }>(sql`
        select head_sha, status, conclusion, count(*)::int as count,
               max(completed_at_ms)::double precision as completed_at_ms
          from ${gitCheckObservations}
         where ${scoped}
         group by head_sha, status, conclusion`);
      for (const row of rows.rows) {
        const evidence = found.get(row.head_sha);
        const suites = evidence?.provider === 'github' ? [...evidence.suites] : [];
        suites.push({
          status: row.status,
          conclusion: row.conclusion,
          count: row.count,
          completedAtMs: row.completed_at_ms,
        });
        found.set(row.head_sha, { provider: 'github', suites });
      }
      return found;
    }
    const rows = await scope.db.execute<{
      readonly head_sha: string;
      readonly attempt_id: number;
      readonly status: GitLabPipeline['status'];
      readonly job_total: number | null;
      readonly job_failed: number | null;
      readonly completed_at_ms: number | null;
    }>(sql`
      select distinct on (head_sha) head_sha, attempt_id::double precision as attempt_id, status,
             job_total::double precision as job_total, job_failed::double precision as job_failed,
             max(completed_at_ms) over (partition by head_sha)::double precision as completed_at_ms
        from ${gitCheckObservations}
       where ${scoped}
       order by head_sha, attempt_id desc`);
    for (const row of rows.rows) {
      found.set(row.head_sha, {
        provider: 'gitlab',
        latest: {
          attemptId: row.attempt_id,
          status: row.status,
          ...(row.job_total === null ? {} : { jobTotal: row.job_total }),
          ...(row.job_failed === null ? {} : { jobFailed: row.job_failed }),
        },
        completedAtMs: row.completed_at_ms,
      });
    }
    return found;
  }

  /**
   * Deletes up to `limit` observations last updated more than 7 days ago whose head is no
   * current head of a link of the same receiver and repository, across organizations, and
   * returns how many it deleted.
   */
  public async pruneExpired(
    scope: TransactionScope<DatabaseSchema>,
    limit: number,
  ): Promise<number> {
    if (scope.kind !== 'system') throw new Error('Check pruning requires a system transaction.');
    const result = await scope.db.execute<{ readonly attempt_id: number }>(sql`
      delete from ${gitCheckObservations}
       where (organization_id, receiver_id, repository_id, head_sha, attempt_id) in (
         select o.organization_id, o.receiver_id, o.repository_id, o.head_sha, o.attempt_id
           from ${gitCheckObservations} o
          where o.updated_at < now() - interval '7 days'
            and not exists (
              select 1 from ${gitLinks} l
               where l.organization_id = o.organization_id
                 and l.receiver_id = o.receiver_id
                 and l.head_sha = o.head_sha
                 and l.identity -> 'binding' ->> 'repositoryId' = o.repository_id::text
            )
          order by o.updated_at
          limit ${limit}
          for update skip locked
       )
      returning attempt_id`);
    return result.rows.length;
  }
  // #endregion
}

function assertTenant(scope: TransactionScope<DatabaseSchema>, organizationId: string): void {
  if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
    throw new Error('Check observation does not belong to the tenant transaction.');
  }
}

function columns(observation: GitCheckObservation): {
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobTotal: number | null;
  readonly jobFailed: number | null;
  readonly observedAtMs: number;
  readonly completedAtMs: number | null;
} {
  return {
    status: observation.status,
    conclusion: observation.provider === 'github' ? observation.conclusion : null,
    jobTotal: observation.provider === 'gitlab' ? (observation.jobTotal ?? null) : null,
    jobFailed: observation.provider === 'gitlab' ? (observation.jobFailed ?? null) : null,
    observedAtMs: observation.observedAtMs,
    completedAtMs: observation.completedAtMs,
  };
}
