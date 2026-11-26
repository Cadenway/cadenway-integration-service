/**
 * Latest verified state of one GitHub check suite or GitLab merge request pipeline for a head
 * SHA of a connected repository, kept apart from any link (Checks, Integration AsyncAPI).
 */
export type GitCheckObservation = {
  /** Suite or pipeline ID and the exact tested revision. */
  readonly attemptId: number;
  readonly headSha: string;

  /** Provider time that orders observations of this suite or pipeline, in Unix milliseconds. */
  readonly observedAtMs: number;

  /** Provider completion time, or null while it runs. */
  readonly completedAtMs: number | null;
} & (
  | {
      readonly provider: 'github';
      readonly status: 'requested' | 'queued' | 'in_progress' | 'pending' | 'waiting' | 'completed';
      readonly conclusion: string | null;
    }
  | {
      readonly provider: 'gitlab';
      readonly status:
        | 'created'
        | 'waiting_for_resource'
        | 'preparing'
        | 'pending'
        | 'running'
        | 'success'
        | 'failed'
        | 'canceled'
        | 'skipped';
      readonly jobTotal?: number;
      readonly jobFailed?: number;
    }
);
