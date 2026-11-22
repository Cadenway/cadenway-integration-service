import { createHash } from 'node:crypto';

import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { GitLinkChanged } from '../../../../../domain/events/links/git-link-changed.event.js';
import { decideGitLinkChange } from '../../../../../domain/policies/links/git-link-change.policy.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';
import type { GitReceiverBinding } from '../../../../../domain/value-objects/deliveries/git-receiver-binding.value-object.js';
import type { GitLinkIdentity } from '../../../../../domain/value-objects/links/git-link-identity.value-object.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitPurgedTasks } from '../../schemas/links/git-purged-tasks.schema.js';

type GitLinkFact = Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;

/** Persists material changes inside the caller's locked dispatch transaction. */
export class DrizzleGitLinkRepository {
  // #region Methods
  /** Finds the tasks linked to the exact verified request, or null if the set exceeds its bound. */
  public async findRequestTaskKeys(
    scope: TransactionScope<DatabaseSchema>,
    input: {
      readonly organizationId: string;
      readonly receiverId: string;
      readonly binding: GitReceiverBinding;
      readonly requestNumber: number;
    },
    headSha?: string,
  ): Promise<readonly string[] | null> {
    if (scope.kind !== 'tenant' || scope.organizationId !== input.organizationId) {
      throw new Error('Git link lookup does not belong to the tenant transaction.');
    }
    const identityHash = linkHash(input.binding, 'pull-request', input.requestNumber);
    const predicates = [
      eq(gitLinks.organizationId, input.organizationId),
      eq(gitLinks.receiverId, input.receiverId),
      eq(gitLinks.provider, input.binding.provider),
      eq(gitLinks.identityHash, identityHash),
      sql`not exists (
        select 1 from ${gitPurgedTasks}
        where ${gitPurgedTasks.organizationId} = ${input.organizationId}
          and ${gitPurgedTasks.taskKey} = ${gitLinks.taskKey}
      )`,
    ];
    if (headSha !== undefined) predicates.push(eq(gitLinks.headSha, headSha));
    const rows = await scope.db
      .select({ taskKey: gitLinks.taskKey, taskId: gitLinks.taskId, identity: gitLinks.identity })
      .from(gitLinks)
      .where(and(...predicates))
      .orderBy(gitLinks.taskKey, gitLinks.id)
      .limit(21);
    // A truncated set must never be treated as the complete audience.
    if (rows.length > 20) return null;
    const keys = new Set<string>();
    for (const row of rows) {
      const identity = row.identity;
      if (
        identity.organizationId !== input.organizationId ||
        identity.receiverId !== input.receiverId ||
        identity.taskId !== row.taskId ||
        identity.kind !== 'pull-request' ||
        identity.requestNumber !== input.requestNumber ||
        !sameBinding(identity.binding, input.binding)
      ) {
        throw new Error('Stored Git link does not match its verified identity.');
      }
      keys.add(row.taskKey);
    }
    return [...keys];
  }

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
    const identityHash = linkHash(
      binding,
      identity.kind,
      identity.kind === 'branch' ? identity.ref : identity.requestNumber,
    );
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
    if (
      current !== undefined &&
      (current.identity.organizationId !== identity.organizationId ||
        current.identity.receiverId !== identity.receiverId ||
        current.identity.taskId !== identity.taskId ||
        current.identity.kind !== identity.kind ||
        !sameBinding(current.identity.binding, identity.binding) ||
        (identity.kind === 'branch' &&
          (current.identity.kind !== 'branch' || current.identity.ref !== identity.ref)) ||
        (identity.kind === 'pull-request' &&
          (current.identity.kind !== 'pull-request' ||
            current.identity.requestNumber !== identity.requestNumber)))
    ) {
      throw new Error('The Git link does not match its stored identity.');
    }
    if (
      current === undefined &&
      (fact.trigger === 'pr_head' ||
        fact.trigger === 'pr_checks' ||
        fact.trigger === 'pr_closed' ||
        (fact.trigger === 'pr_merged' &&
          fact.referencedTaskKeys !== undefined &&
          !fact.referencedTaskKeys.includes(taskKey)))
    ) {
      return null;
    }
    if (fact.trigger === 'pr_checks') {
      if (
        identity.kind !== 'pull-request' ||
        identity.requestNumber !== fact.requestNumber ||
        fact.checks.requestNumber !== fact.requestNumber
      ) {
        throw new Error('The verified checks do not match the Git request identity.');
      }
      if (current?.headSha !== fact.checks.headSha) return null;
      const { attemptId, completedAtMs } = fact.checks;
      if (
        current.headFirstObservedAtMs === null ||
        completedAtMs < current.headFirstObservedAtMs ||
        (current.checksCompletedAtMs !== null &&
          (completedAtMs < current.checksCompletedAtMs ||
            (completedAtMs === current.checksCompletedAtMs &&
              attemptId <= (current.checksAttemptId ?? 0))))
      ) {
        return null;
      }
      const version = current.version + 1;
      if (!Number.isSafeInteger(version)) throw new Error('Git link version exhausted.');
      await scope.db
        .update(gitLinks)
        .set({
          checksAttemptId: attemptId,
          checksCompletedAtMs: completedAtMs,
          version,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(gitLinks.organizationId, identity.organizationId), eq(gitLinks.id, current.id)),
        );
      return { id: current.id, event: { type: 'checks-completed', version } };
    }
    const head = fact.trigger === 'branch' ? undefined : fact.head;
    const headUpdate =
      head !== undefined &&
      (current?.headLastObservedAtMs === null ||
        current?.headLastObservedAtMs === undefined ||
        head.observedAtMs > current.headLastObservedAtMs);
    const headChanged = headUpdate && current?.headSha !== head.sha;
    const headValues = headUpdate
      ? {
          headSha: head.sha,
          headFirstObservedAtMs: headChanged ? head.observedAtMs : current?.headFirstObservedAtMs,
          headLastObservedAtMs: head.observedAtMs,
          ...(headChanged ? { checksAttemptId: null, checksCompletedAtMs: null } : {}),
        }
      : {};
    // The domain compares the full stored identity, including the original ref, after hash lookup.
    const change = decideGitLinkChange(
      identity,
      current === undefined
        ? null
        : { identity: current.identity, status: current.status, version: current.version },
      fact,
    );
    if (change === null) {
      if (current !== undefined && headUpdate) {
        await scope.db
          .update(gitLinks)
          .set({ ...headValues, updatedAt: sql`now()` })
          .where(
            and(eq(gitLinks.organizationId, identity.organizationId), eq(gitLinks.id, current.id)),
          );
      }
      return null;
    }
    if (current !== undefined) {
      await scope.db
        .update(gitLinks)
        .set({
          ...headValues,
          status: change.state.status,
          version: change.state.version,
          updatedAt: sql`now()`,
        })
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
        ...headValues,
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

function linkHash(
  binding: GitReceiverBinding,
  kind: GitLinkIdentity['kind'],
  reference: string | number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        binding.provider,
        binding.repositoryId,
        binding.provider === 'github' ? binding.installationId : null,
        kind,
        reference,
      ]),
    )
    .digest('hex');
}

function sameBinding(first: GitReceiverBinding, second: GitReceiverBinding): boolean {
  if (first.provider !== second.provider || first.repositoryId !== second.repositoryId)
    return false;
  return (
    first.provider !== 'github' ||
    (second.provider === 'github' && first.installationId === second.installationId)
  );
}
