import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { replacesGitCheckObservation } from '../../../../../domain/policies/checks/order-git-check-observation.policy.js';
import type { GitCheckObservation } from '../../../../../domain/value-objects/checks/git-check-observation.value-object.js';
import { gitCheckObservations } from '../../schemas/checks/git-check-observations.schema.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';

type Row = typeof gitCheckObservations.$inferSelect;

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
  /** Upserts the observation of a suite or pipeline under its provider-time watermark. */
  public async record(
    scope: TransactionScope<DatabaseSchema>,
    repository: CheckRepository,
    observation: GitCheckObservation,
  ): Promise<'recorded' | 'ignored'> {
    assertTenant(scope, repository.organizationId);
    if (observation.provider !== repository.provider) {
      throw new Error('The check observation does not match its repository provider.');
    }
    const key = {
      organizationId: repository.organizationId,
      receiverId: repository.receiverId,
      repositoryId: repository.repositoryId,
      headSha: observation.headSha,
      attemptId: observation.attemptId,
    };
    const values = { ...key, provider: repository.provider, ...columns(observation) };
    const inserted = await scope.db
      .insert(gitCheckObservations)
      .values(values)
      .onConflictDoNothing()
      .returning({ attemptId: gitCheckObservations.attemptId });
    if (inserted.length !== 0) return 'recorded';

    const rows = await scope.db
      .select()
      .from(gitCheckObservations)
      .where(and(...keyPredicates(key)))
      .limit(1)
      .for('update');
    const stored = rows[0];
    if (stored !== undefined && !replacesGitCheckObservation(toObservation(stored), observation)) {
      return 'ignored';
    }
    await scope.db
      .update(gitCheckObservations)
      .set({ ...columns(observation), updatedAt: sql`now()` })
      .where(and(...keyPredicates(key)));
    return 'recorded';
  }

  /** Loads the observations of the given heads, at most 100 suites or pipelines per head. */
  public async findForHeads(
    scope: TransactionScope<DatabaseSchema>,
    repository: CheckRepository,
    headShas: readonly string[],
  ): Promise<ReadonlyMap<string, readonly GitCheckObservation[]>> {
    assertTenant(scope, repository.organizationId);
    const found = new Map<string, GitCheckObservation[]>();
    if (headShas.length === 0) return found;
    const rows = await scope.db
      .select()
      .from(gitCheckObservations)
      .where(
        and(
          eq(gitCheckObservations.organizationId, repository.organizationId),
          eq(gitCheckObservations.receiverId, repository.receiverId),
          eq(gitCheckObservations.repositoryId, repository.repositoryId),
          eq(gitCheckObservations.provider, repository.provider),
          inArray(gitCheckObservations.headSha, [...headShas]),
        ),
      )
      .orderBy(gitCheckObservations.headSha, gitCheckObservations.attemptId)
      .limit(100 * headShas.length);
    for (const row of rows) {
      const list = found.get(row.headSha) ?? [];
      list.push(toObservation(row));
      found.set(row.headSha, list);
    }
    return found;
  }

  /**
   * Deletes up to `limit` observations last updated more than 7 days ago whose head is no
   * link's current head, across organizations, and returns how many it deleted.
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

function keyPredicates(key: {
  readonly organizationId: string;
  readonly receiverId: string;
  readonly repositoryId: number;
  readonly headSha: string;
  readonly attemptId: number;
}): ReturnType<typeof eq>[] {
  return [
    eq(gitCheckObservations.organizationId, key.organizationId),
    eq(gitCheckObservations.receiverId, key.receiverId),
    eq(gitCheckObservations.repositoryId, key.repositoryId),
    eq(gitCheckObservations.headSha, key.headSha),
    eq(gitCheckObservations.attemptId, key.attemptId),
  ];
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

function toObservation(row: Row): GitCheckObservation {
  const base = {
    attemptId: row.attemptId,
    headSha: row.headSha,
    observedAtMs: row.observedAtMs,
    completedAtMs: row.completedAtMs,
  };
  if (row.provider === 'github') {
    return {
      ...base,
      provider: 'github',
      status: row.status as Extract<GitCheckObservation, { provider: 'github' }>['status'],
      conclusion: row.conclusion,
    };
  }
  return {
    ...base,
    provider: 'gitlab',
    status: row.status as Extract<GitCheckObservation, { provider: 'gitlab' }>['status'],
    ...(row.jobTotal === null ? {} : { jobTotal: row.jobTotal }),
    ...(row.jobFailed === null ? {} : { jobFailed: row.jobFailed }),
  };
}
