import type { GitCheckObservation } from '../../value-objects/checks/git-check-observation.value-object.js';
import type { GitChecksAggregate } from '../../value-objects/checks/git-checks-aggregate.value-object.js';

const GITHUB_FAILED = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);
const GITLAB_STATE = {
  failed: 'failed',
  canceled: 'failed',
  created: 'running',
  waiting_for_resource: 'running',
  preparing: 'running',
  pending: 'running',
  running: 'running',
  success: 'passed',
  skipped: 'passed',
} as const;

/**
 * Computes the checks of one head from its stored observations (GitChecks and "Checks" in the
 * Integration contract). GitHub leaves out a `stale` suite and counts suites: `failed` when a
 * completed suite failed, else `running` while one has not completed, else `passed`. GitLab uses
 * the pipeline with the highest ID and counts its jobs. With no eligible observation the
 * aggregate is absent. The completion time is the latest provider completion among the
 * eligible observations.
 */
export function aggregateGitChecks(observations: readonly GitCheckObservation[]): {
  readonly checks: GitChecksAggregate | null;
  readonly completedAtMs: number | null;
} {
  const eligible = observations.filter(
    (observation) => observation.provider !== 'github' || observation.conclusion !== 'stale',
  );
  let completedAtMs: number | null = null;
  for (const observation of eligible) {
    if (observation.completedAtMs !== null) {
      completedAtMs = Math.max(completedAtMs ?? 0, observation.completedAtMs);
    }
  }
  if (eligible.length === 0) return { checks: null, completedAtMs };

  const latest = eligible.reduce((first, second) =>
    second.attemptId > first.attemptId ? second : first,
  );
  if (latest.provider === 'gitlab') {
    const checks: GitChecksAggregate = {
      state: GITLAB_STATE[latest.status],
      ...(latest.jobTotal === undefined ? {} : { total: latest.jobTotal }),
      ...(latest.jobFailed === undefined ? {} : { failed: latest.jobFailed }),
    };
    return { checks, completedAtMs };
  }

  let failed = 0;
  let running = false;
  for (const observation of eligible) {
    if (observation.provider !== 'github') continue;
    if (observation.status !== 'completed') running = true;
    else if (observation.conclusion !== null && GITHUB_FAILED.has(observation.conclusion)) {
      failed += 1;
    }
  }
  const state = failed > 0 ? 'failed' : running ? 'running' : 'passed';
  return { checks: { state, total: eligible.length, failed }, completedAtMs };
}
