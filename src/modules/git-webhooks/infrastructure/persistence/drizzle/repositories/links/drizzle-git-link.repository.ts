import { createHash } from 'node:crypto';

import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { GitLinkChanged } from '../../../../../domain/events/links/git-link-changed.event.js';
import { decideGitLinkChange } from '../../../../../domain/policies/links/git-link-change.policy.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';
import type { GitLinkIdentity } from '../../../../../domain/value-objects/links/git-link-identity.value-object.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitPurgedTasks } from '../../schemas/links/git-purged-tasks.schema.js';

type GitLinkFact = Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;

/** Persists material changes inside the caller's locked dispatch transaction. */
export class DrizzleGitLinkRepository {
  // #region Methods
  /** Reserves a stable link ID and returns only a new fact for the caller's outbox. */
  public async record(
    scope: TransactionScope<DatabaseSchema>,
    identity: GitLinkIdentity,
    fact: GitLinkFact,
    taskKey: string,
  ): Promise<{ readonly id: string; readonly event: GitLinkChanged } | null> {
    if (scope.kind !== 'tenant' || scope.organizationId !== identity.organizationId) {
      throw new Error('Git link does not belong to the tenant transaction.');
    }
    if (!fact.taskKeys.includes(taskKey) || !/^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u.test(taskKey)) {
      throw new Error('Git link does not belong to the admitted task.');
    }
    await this.lockTask(scope, identity.organizationId, taskKey);
    const purged = await scope.db
      .select({ taskKey: gitPurgedTasks.taskKey })
      .from(gitPurgedTasks)
      .where(
        and(
          eq(gitPurgedTasks.organizationId, identity.organizationId),
          eq(gitPurgedTasks.taskKey, taskKey),
        ),
      )
      .limit(1);
    if (purged.length !== 0) return null;
    const binding = identity.binding;
    const identityHash = createHash('sha256')
      .update(
        JSON.stringify([
          binding.provider,
          binding.repositoryId,
          binding.provider === 'github' ? binding.installationId : null,
          identity.kind,
          identity.kind === 'branch' ? identity.ref : identity.requestNumber,
        ]),
      )
      .digest('hex');
    const conditions = and(
      eq(gitLinks.organizationId, identity.organizationId),
      eq(gitLinks.receiverId, identity.receiverId),
      eq(gitLinks.taskId, identity.taskId),
      eq(gitLinks.identityHash, identityHash),
    );
    const rows = await scope.db.select().from(gitLinks).where(conditions).limit(1).for('update');
    const current = rows[0];
    if (current !== undefined && current.taskKey !== taskKey) {
      throw new Error('The Git link task key does not match its stored identity.');
    }
    // The domain compares the full stored identity, including the original ref, after hash lookup.
    const change = decideGitLinkChange(
      identity,
      current === undefined
        ? null
        : { identity: current.identity, status: current.status, version: current.version },
      fact,
    );
    if (change === null) return null;
    if (current !== undefined) {
      await scope.db
        .update(gitLinks)
        .set({ status: change.state.status, version: change.state.version, updatedAt: sql`now()` })
        .where(
          and(eq(gitLinks.organizationId, identity.organizationId), eq(gitLinks.id, current.id)),
        );
      return { id: current.id, event: change.event };
    }
    const inserted = await scope.db
      .insert(gitLinks)
      .values({
        organizationId: identity.organizationId,
        receiverId: identity.receiverId,
        provider: binding.provider,
        taskId: identity.taskId,
        taskKey,
        identityHash,
        identity,
        status: change.state.status,
        version: change.state.version,
      })
      .returning({ id: gitLinks.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('Git link was not recorded.');
    return { id: row.id, event: change.event };
  }

  /** Records terminal purge and removes at most 500 links, returning whether another pass may be needed. */
  public async purge(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    taskKey: string,
  ): Promise<{ readonly hasMore: boolean }> {
    if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
      throw new Error('Git purge does not belong to the tenant transaction.');
    }
    if (!/^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u.test(taskKey)) {
      throw new Error('Git purge requires a canonical task key.');
    }
    await this.lockTask(scope, organizationId, taskKey);
    await scope.db.insert(gitPurgedTasks).values({ organizationId, taskKey }).onConflictDoNothing();
    const candidates = await scope.db
      .select({ id: gitLinks.id })
      .from(gitLinks)
      .where(and(eq(gitLinks.organizationId, organizationId), eq(gitLinks.taskKey, taskKey)))
      .orderBy(gitLinks.id)
      .limit(500);
    if (candidates.length !== 0) {
      await scope.db.delete(gitLinks).where(
        and(
          eq(gitLinks.organizationId, organizationId),
          eq(gitLinks.taskKey, taskKey),
          inArray(
            gitLinks.id,
            candidates.map(({ id }) => id),
          ),
        ),
      );
    }
    return { hasMore: candidates.length === 500 };
  }

  /** Serializes task purges and dispatch completion without taking another receiver lock. */
  private async lockTask(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    taskKey: string,
  ): Promise<void> {
    await scope.db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + taskKey}, 0))`,
    );
  }
  // #endregion
}
