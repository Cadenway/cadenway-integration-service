import type { PoolClient } from 'pg';

/** Serializes the finalization across migrator sessions. */
const migrationLock = 'integration-service:git-link-projection';

/** Indexes of `git_links` that migration 0008 declares and this step builds concurrently. */
const indexes: readonly { readonly name: string; readonly definition: string }[] = [
  {
    name: 'git_links_task_page_index',
    definition: `on public.git_links using btree
      (organization_id, task_key, created_at desc nulls last, id desc nulls last)`,
  },
  {
    name: 'git_links_head_lookup_index',
    definition: `on public.git_links using btree (organization_id, receiver_id, head_sha)
      where head_sha is not null`,
  },
  {
    name: 'git_links_reconciliation_index',
    definition: `on public.git_links using btree (reconciliation_pending_since)
      where reconciliation_pending_since is not null and reconciliation_reported_at is null`,
  },
];

/** Checks migration 0008 adds `NOT VALID` to `git_links`, validated here without a long lock. */
const constraints: readonly string[] = [
  'git_links_checks_completed_check',
  'git_links_aggregate_check',
  'git_links_lifecycle_observed_check',
  'git_links_line_counts_check',
  'git_links_link_source_check',
  'git_links_members_check',
];

const backfillBatch = 1_000;

/**
 * Completes migration 0008 after the Drizzle transaction commits, as the outbox lease expansion
 * of the service kit does (expand/contract migrations: indexes built concurrently, constraints
 * validated apart). Safe to run again:
 *
 * 1. builds the new `git_links` indexes concurrently, rebuilding one left invalid;
 * 2. validates the new `git_links` checks, which only takes a share update exclusive lock;
 * 3. backfills the lifecycle watermark of request links recorded before it existed, from their
 *    last head observation, in batches of 1,000 until none is left, waiting for a row a running
 *    dispatch holds. Until then, the projection reads the same fallback.
 *
 * @param client - A migrator session outside any transaction, released by the caller.
 */
export async function finishGitLinkProjectionMigration(client: PoolClient): Promise<void> {
  const lock = await client.query<{ readonly acquired: boolean }>(
    'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
    [migrationLock],
  );
  if (lock.rows[0]?.acquired !== true) {
    throw new Error('Another migrator is finalizing the Git link projection. Retry after it ends.');
  }
  try {
    for (const index of indexes) {
      const state = await client.query<{ readonly valid: boolean }>(
        `select i.indisvalid as valid from pg_index i
           join pg_class c on c.oid = i.indexrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $1`,
        [index.name],
      );
      const valid = state.rows[0]?.valid;
      if (valid === true) continue;
      if (valid === false) await client.query(`drop index concurrently public.${index.name}`);
      await client.query(`create index concurrently ${index.name} ${index.definition}`);
    }
    await client.query(
      `alter table public.git_links ${constraints
        .map((constraint) => `validate constraint ${constraint}`)
        .join(', ')}`,
    );
    // The table forces row-level security, also on its owner: the backfill crosses organizations.
    await client.query("select set_config('app.system_access', 'on', false)");
    for (;;) {
      const batch = await client.query(
        `update public.git_links
            set lifecycle_observed_at_ms = head_last_observed_at_ms
          where (organization_id, id) in (
            select organization_id, id from public.git_links
             where identity ->> 'kind' = 'pull-request'
               and lifecycle_observed_at_ms is null
               and head_last_observed_at_ms is not null
             limit $1
             for update)`,
        [backfillBatch],
      );
      // Waits for a row a running dispatch holds: the loop ends once no eligible row is left.
      if ((batch.rowCount ?? 0) === 0) break;
    }
  } finally {
    await client.query("select set_config('app.system_access', '', false)");
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [migrationLock]);
  }
}
