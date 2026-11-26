import { describe, expect, it } from 'vitest';

import type { GitChecksEvidence } from '../../value-objects/checks/git-checks-evidence.value-object.js';
import { aggregateGitChecks } from './aggregate-git-checks.policy.js';

const T = Date.UTC(2026, 10, 7, 15, 20);

function github(
  ...suites: readonly [
    status: 'queued' | 'in_progress' | 'completed',
    conclusion: string | null,
    count: number,
    completedAtMs?: number,
  ][]
): GitChecksEvidence {
  return {
    provider: 'github',
    suites: suites.map(([status, conclusion, count, completedAtMs]) => ({
      status,
      conclusion,
      count,
      completedAtMs: status === 'completed' ? (completedAtMs ?? T) : null,
    })),
  };
}

describe('Git checks aggregate', () => {
  it('is absent without an eligible observation', () => {
    expect(aggregateGitChecks(null)).toEqual({ checks: null, completedAtMs: null });
    expect(aggregateGitChecks(github(['completed', 'stale', 3]))).toEqual({
      checks: null,
      completedAtMs: null,
    });
  });

  it('fails as soon as a completed suite failed, even while others run', () => {
    expect(
      aggregateGitChecks(
        github(
          ['completed', 'timed_out', 1],
          ['in_progress', null, 1],
          ['completed', 'success', 1, T + 1],
        ),
      ),
    ).toEqual({ checks: { state: 'failed', total: 3, failed: 1 }, completedAtMs: T + 1 });
  });

  it('counts every suite of a large head exactly', () => {
    expect(
      aggregateGitChecks(github(['completed', 'success', 140], ['completed', 'failure', 2])),
    ).toEqual({ checks: { state: 'failed', total: 142, failed: 2 }, completedAtMs: T });
  });

  it('runs while a suite is queued and passes once every suite succeeded, was neutral or skipped', () => {
    expect(aggregateGitChecks(github(['queued', null, 1])).checks).toEqual({
      state: 'running',
      total: 1,
      failed: 0,
    });
    expect(
      aggregateGitChecks(
        github(
          ['completed', 'success', 1],
          ['completed', 'neutral', 1],
          ['completed', 'skipped', 1],
          ['completed', 'stale', 1, T + 10],
        ),
      ),
    ).toEqual({ checks: { state: 'passed', total: 3, failed: 0 }, completedAtMs: T });
  });

  it('uses the latest GitLab pipeline and its job counts', () => {
    expect(
      aggregateGitChecks({
        provider: 'gitlab',
        latest: { attemptId: 32, status: 'running', jobTotal: 4, jobFailed: 0 },
        completedAtMs: T,
      }),
    ).toEqual({ checks: { state: 'running', total: 4, failed: 0 }, completedAtMs: T });
    expect(
      aggregateGitChecks({
        provider: 'gitlab',
        latest: { attemptId: 33, status: 'canceled' },
        completedAtMs: T + 5,
      }).checks,
    ).toEqual({ state: 'failed' });
  });
});
