import type { GitChecksAggregate } from '../../value-objects/checks/git-checks-aggregate.value-object.js';
import type { GitChecksEvidence } from '../../value-objects/checks/git-checks-evidence.value-object.js';

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
 * Computes the checks of one head from the evidence of its stored observations (GitChecks and
 * "Checks" in the Integration contract). GitHub leaves out a `stale` suite and counts suites:
 * `failed` when a completed suite failed, else `running` while one has not completed, else
 * `passed`. GitLab uses the pipeline with the highest ID and counts its jobs. With no eligible
 * observation the aggregate is absent. The completion time is the latest provider completion
 * among the eligible observations.
 */
export function aggregateGitChecks(evidence: GitChecksEvidence | null): {
  readonly checks: GitChecksAggregate | null;
  readonly completedAtMs: number | null;
} {
  if (evidence === null) return { checks: null, completedAtMs: null };
  if (evidence.provider === 'gitlab') {
    const { latest } = evidence;
    const checks: GitChecksAggregate = {
      state: GITLAB_STATE[latest.status],
      ...(latest.jobTotal === undefined ? {} : { total: latest.jobTotal }),
      ...(latest.jobFailed === undefined ? {} : { failed: latest.jobFailed }),
    };
    return { checks, completedAtMs: evidence.completedAtMs };
  }

  let total = 0;
  let failed = 0;
  let running = false;
  let completedAtMs: number | null = null;
  for (const suite of evidence.suites) {
    if (suite.conclusion === 'stale' || suite.count < 1) continue;
    total += suite.count;
    if (suite.completedAtMs !== null) {
      completedAtMs = Math.max(completedAtMs ?? 0, suite.completedAtMs);
    }
    if (suite.status !== 'completed') running = true;
    else if (suite.conclusion !== null && GITHUB_FAILED.has(suite.conclusion)) {
      failed += suite.count;
    }
  }
  if (total === 0) return { checks: null, completedAtMs };
  const state = failed > 0 ? 'failed' : running ? 'running' : 'passed';
  return { checks: { state, total, failed }, completedAtMs };
}
