import { createHash } from 'node:crypto';

import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

import { decideGitLinkUpdate } from '../../../../../domain/policies/links/decide-git-link-update.policy.js';
import { gitLinkDeliveryOf } from '../../../../../domain/policies/links/git-link-change.policy.js';
import type { GitLinkChanged } from '../../../../../domain/events/links/git-link-changed.event.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';
import type { GitReceiverBinding } from '../../../../../domain/value-objects/deliveries/git-receiver-binding.value-object.js';
import type { GitChecksEvidence } from '../../../../../domain/value-objects/checks/git-checks-evidence.value-object.js';
import type { GitLinkIdentity } from '../../../../../domain/value-objects/links/git-link-identity.value-object.js';
import type { GitLinkProjection } from '../../../../../domain/value-objects/links/git-link-projection.value-object.js';
import { DrizzleGitCheckObservationRepository } from '../checks/drizzle-git-check-observation.repository.js';
import { gitLinks } from '../../schemas/links/git-links.schema.js';
import { gitPurgedTasks } from '../../schemas/links/git-purged-tasks.schema.js';

type GitLinkFact = Exclude<
  Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>,
  { readonly trigger: 'head_checks' }
>;
type Row = typeof gitLinks.$inferSelect;
type ProjectionColumns = Omit<
  typeof gitLinks.$inferInsert,
  | 'organizationId'
  | 'id'
  | 'receiverId'
  | 'provider'
  | 'taskId'
  | 'taskKey'
  | 'identityHash'
  | 'identity'
  | 'createdAt'
  | 'updatedAt'
  | 'reconciliationPendingSince'
> & { readonly reconciliationPendingSince?: SQL | null };

/** Persists material changes inside the caller's locked dispatch transaction. */
export class DrizzleGitLinkRepository {
  // #region Constructor
  /** Reads the stored check observations of the link's repository. */
  public constructor(private readonly observations = new DrizzleGitCheckObservationRepository()) {}
  // #endregion

  // #region Methods
  /**
   * Finds the pull request links of the receiver's repository whose current head is `headSha`,
   * whatever their request, or null when they exceed the bound of 20 links.
   */
  public async findHeadTargets(
    scope: TransactionScope<DatabaseSchema>,
    input: {
      readonly organizationId: string;
      readonly receiverId: string;
      readonly binding: GitReceiverBinding;
      readonly headSha: string;
    },
  ): Promise<readonly { readonly taskKey: string; readonly requestNumber: number }[] | null> {
    if (scope.kind !== 'tenant' || scope.organizationId !== input.organizationId) {
      throw new Error('Git link lookup does not belong to the tenant transaction.');
    }
    const { binding } = input;
    const rows = await scope.db
      .select({ taskKey: gitLinks.taskKey, taskId: gitLinks.taskId, identity: gitLinks.identity })
      .from(gitLinks)
      .where(
        and(
          eq(gitLinks.organizationId, input.organizationId),
          eq(gitLinks.receiverId, input.receiverId),
          eq(gitLinks.provider, binding.provider),
          eq(gitLinks.headSha, input.headSha),
          sql`${gitLinks.identity} ->> 'kind' = 'pull-request'`,
          sql`${gitLinks.identity} -> 'binding' ->> 'repositoryId' = ${String(binding.repositoryId)}`,
          sql`not exists (
            select 1 from ${gitPurgedTasks}
            where ${gitPurgedTasks.organizationId} = ${input.organizationId}
              and ${gitPurgedTasks.taskKey} = ${gitLinks.taskKey}
          )`,
        ),
      )
      .orderBy(gitLinks.taskKey, gitLinks.id)
      .limit(21);
    // A truncated set must never be treated as the complete audience.
    if (rows.length > 20) return null;
    const targets: { readonly taskKey: string; readonly requestNumber: number }[] = [];
    for (const row of rows) {
      const { identity } = row;
      if (
        identity.organizationId !== input.organizationId ||
        identity.receiverId !== input.receiverId ||
        identity.taskId !== row.taskId ||
        identity.kind !== 'pull-request'
      ) {
        throw new Error('Stored Git link does not match its verified identity.');
      }
      // The installation is part of a GitHub binding: another installation's link is not this one.
      if (!sameBinding(identity.binding, binding)) continue;
      if (
        !targets.some(
          (target) =>
            target.taskKey === row.taskKey && target.requestNumber === identity.requestNumber,
        )
      ) {
        targets.push({ taskKey: row.taskKey, requestNumber: identity.requestNumber });
      }
    }
    return targets;
  }

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

  /**
   * Applies one delivery to the link of one task under the task lock and the link row lock,
   * which serialize deliveries for the same link. Returns the stable link ID with the facts the
   * caller appends in the same transaction, or null when no link exists or may be created.
   */
  public async record(
    scope: TransactionScope<DatabaseSchema>,
    identity: GitLinkIdentity,
    fact: GitLinkFact,
    taskKey: string,
    admissionSequence = 0,
  ): Promise<{
    readonly id: string;
    readonly events: readonly GitLinkChanged[];
    readonly reconciliation: 'marked' | 'cleared' | 'unchanged';
  } | null> {
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
    if (current !== undefined) assertStoredIdentity(current, identity, taskKey);
    if (
      fact.trigger === 'pr_checks' &&
      (identity.kind !== 'pull-request' ||
        identity.requestNumber !== fact.requestNumber ||
        fact.checks.requestNumber !== fact.requestNumber)
    ) {
      throw new Error('The verified checks do not match the Git request identity.');
    }

    const delivery = gitLinkDeliveryOf(fact, taskKey, admissionSequence);
    const heads = new Set<string>();
    if (delivery.head !== null) heads.add(delivery.head.sha);
    if (current?.headSha !== null && current?.headSha !== undefined) heads.add(current.headSha);
    const observations =
      identity.kind === 'branch'
        ? new Map<string, GitChecksEvidence>()
        : await this.observations.findEvidenceForHeads(
            scope,
            {
              organizationId: identity.organizationId,
              receiverId: identity.receiverId,
              provider: binding.provider,
              repositoryId: binding.repositoryId,
            },
            [...heads],
          );
    // The domain compares the full stored identity, including the original ref, after hash lookup.
    const decision = decideGitLinkUpdate(
      current === undefined ? null : toProjection(current),
      delivery,
      (headSha) => observations.get(headSha) ?? null,
    );
    if (decision === null) return null;

    const values = toColumns(decision.projection, decision.reconciliation);
    if (current !== undefined) {
      await scope.db
        .update(gitLinks)
        .set({
          ...values,
          ...(decision.events.length === 0 ? {} : { updatedAt: sql`now()` }),
        })
        .where(
          and(eq(gitLinks.organizationId, identity.organizationId), eq(gitLinks.id, current.id)),
        );
      return { id: current.id, events: decision.events, reconciliation: decision.reconciliation };
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
        ...values,
      })
      .returning({ id: gitLinks.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('Git link was not recorded.');
    return { id: row.id, events: decision.events, reconciliation: decision.reconciliation };
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

function assertStoredIdentity(current: Row, identity: GitLinkIdentity, taskKey: string): void {
  if (current.taskKey !== taskKey) {
    throw new Error('The Git link task key does not match its stored identity.');
  }
  if (
    current.identity.organizationId !== identity.organizationId ||
    current.identity.receiverId !== identity.receiverId ||
    current.identity.taskId !== identity.taskId ||
    current.identity.kind !== identity.kind ||
    !sameBinding(current.identity.binding, identity.binding) ||
    (identity.kind === 'branch' &&
      (current.identity.kind !== 'branch' || current.identity.ref !== identity.ref)) ||
    (identity.kind === 'pull-request' &&
      (current.identity.kind !== 'pull-request' ||
        current.identity.requestNumber !== identity.requestNumber))
  ) {
    throw new Error('The Git link does not match its stored identity.');
  }
}

/** Maps a stored row to the domain projection; absent members stay absent. */
function toProjection(row: Row): GitLinkProjection {
  const members: Record<string, unknown> = {
    title: row.title,
    draft: row.draft,
    url: row.url,
    repository: row.repository,
    sourceBranch: row.sourceBranch,
    author: row.author,
    reviewRequested: row.reviewRequested,
    additions: row.additions,
    deletions: row.deletions,
  };
  return {
    status: row.status,
    version: row.version,
    lifecycleObservedAtMs: row.lifecycleObservedAtMs,
    lifecycleAdmissionSequence: row.lifecycleAdmissionSequence ?? 0,
    members: Object.fromEntries(Object.entries(members).filter(([, value]) => value !== null)),
    memberObservedAtMs: row.memberObservedAtMs,
    memberAdmissionSequence: row.memberAdmissionSequence,
    linkSource: row.linkSource,
    head:
      row.headSha === null ||
      row.headFirstObservedAtMs === null ||
      row.headLastObservedAtMs === null
        ? null
        : {
            sha: row.headSha,
            firstObservedAtMs: row.headFirstObservedAtMs,
            lastObservedAtMs: row.headLastObservedAtMs,
            admissionSequence: row.headAdmissionSequence ?? 0,
          },
    checks: row.checks,
    checksCompletedAtMs: row.checksCompletedAtMs,
    reconciliationPending: row.reconciliationPendingSince !== null,
  };
}

function toColumns(
  projection: GitLinkProjection,
  reconciliation: 'marked' | 'cleared' | 'unchanged',
): ProjectionColumns {
  const { members } = projection;
  return {
    status: projection.status,
    version: projection.version,
    lifecycleObservedAtMs: projection.lifecycleObservedAtMs,
    lifecycleAdmissionSequence: projection.lifecycleAdmissionSequence,
    title: members.title ?? null,
    draft: members.draft ?? null,
    url: members.url ?? null,
    repository: members.repository ?? null,
    sourceBranch: members.sourceBranch ?? null,
    author: members.author ?? null,
    reviewRequested: members.reviewRequested ?? null,
    additions: members.additions ?? null,
    deletions: members.deletions ?? null,
    linkSource: projection.linkSource,
    memberObservedAtMs: projection.memberObservedAtMs,
    memberAdmissionSequence: projection.memberAdmissionSequence,
    headSha: projection.head?.sha ?? null,
    headFirstObservedAtMs: projection.head?.firstObservedAtMs ?? null,
    headLastObservedAtMs: projection.head?.lastObservedAtMs ?? null,
    headAdmissionSequence: projection.head?.admissionSequence ?? null,
    checksAttemptId: null,
    checks: projection.checks,
    checksCompletedAtMs: projection.checksCompletedAtMs,
    ...(reconciliation === 'marked'
      ? { reconciliationPendingSince: sql`now()` }
      : reconciliation === 'cleared'
        ? { reconciliationPendingSince: null }
        : {}),
  };
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
