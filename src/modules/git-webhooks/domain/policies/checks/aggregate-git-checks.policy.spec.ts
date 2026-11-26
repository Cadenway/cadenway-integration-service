import { describe, expect, it } from 'vitest';

import type { GitCheckObservation } from '../../value-objects/checks/git-check-observation.value-object.js';
import { aggregateGitChecks } from './aggregate-git-checks.policy.js';
import { replacesGitCheckObservation } from './order-git-check-observation.policy.js';

const headSha = 'c'.repeat(40);
const T = Date.UTC(2026, 10, 7, 15, 20);

function suite(
  attemptId: number,
  status: 'queued' | 'in_progress' | 'completed',
  conclusion: string | null,
  at = T,
): GitCheckObservation {
  return {
    provider: 'github',
    attemptId,
    headSha,
    observedAtMs: at,
    completedAtMs: status === 'completed' ? at : null,
    status,
    conclusion,
  };
}

describe('Git checks aggregate', () => {
  it('is absent without an eligible observation', () => {
    expect(aggregateGitChecks([])).toEqual({ checks: null, completedAtMs: null });
    expect(aggregateGitChecks([suite(1, 'completed', 'stale')])).toEqual({
      checks: null,
      completedAtMs: null,
    });
  });

  it('fails as soon as a completed suite failed, even while others run', () => {
    expect(
      aggregateGitChecks([
        suite(1, 'completed', 'timed_out'),
        suite(2, 'in_progress', null),
        suite(3, 'completed', 'success', T + 1),
      ]),
    ).toEqual({ checks: { state: 'failed', total: 3, failed: 1 }, completedAtMs: T + 1 });
  });

  it('runs while a suite is queued and passes once every suite succeeded, was neutral or skipped', () => {
    expect(aggregateGitChecks([suite(1, 'queued', null)]).checks).toEqual({
      state: 'running',
      total: 1,
      failed: 0,
    });
    expect(
      aggregateGitChecks([
        suite(1, 'completed', 'success'),
        suite(2, 'completed', 'neutral'),
        suite(3, 'completed', 'skipped'),
        suite(4, 'completed', 'stale', T + 10),
      ]),
    ).toEqual({ checks: { state: 'passed', total: 3, failed: 0 }, completedAtMs: T });
  });

  it('uses the GitLab pipeline with the highest ID and its job counts', () => {
    const pipeline = (
      attemptId: number,
      status: 'running' | 'failed' | 'canceled',
      completedAtMs: number | null,
    ): GitCheckObservation => ({
      provider: 'gitlab',
      attemptId,
      headSha,
      observedAtMs: completedAtMs ?? T,
      completedAtMs,
      status,
      jobTotal: 4,
      jobFailed: status === 'running' ? 0 : 1,
    });
    expect(aggregateGitChecks([pipeline(31, 'failed', T), pipeline(32, 'running', null)])).toEqual({
      checks: { state: 'running', total: 4, failed: 0 },
      completedAtMs: T,
    });
    expect(aggregateGitChecks([pipeline(33, 'canceled', T + 5)]).checks?.state).toBe('failed');
  });

  it('replaces a stored observation with an equal or newer one only', () => {
    const stored = suite(1, 'completed', 'success');
    expect(replacesGitCheckObservation(null, stored)).toBe(true);
    expect(replacesGitCheckObservation(stored, suite(1, 'queued', null, T))).toBe(true);
    expect(replacesGitCheckObservation(stored, suite(1, 'queued', null, T - 1))).toBe(false);
  });
});
