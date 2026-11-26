import { describe, expect, it } from 'vitest';

import {
  decideGitMergeIntentRetry,
  gitMergeIntentWindowMs,
} from './decide-git-merge-intent-retry.policy.js';

const createdAt = Date.UTC(2026, 10, 8, 10, 41);

describe('Git merge intent retries', () => {
  it('backs off from one minute, doubling up to one hour', () => {
    expect(decideGitMergeIntentRetry(createdAt, 1, createdAt)).toEqual({
      status: 'retry',
      startAfterMs: createdAt + 60_000,
    });
    expect(decideGitMergeIntentRetry(createdAt, 3, createdAt)).toEqual({
      status: 'retry',
      startAfterMs: createdAt + 240_000,
    });
    expect(decideGitMergeIntentRetry(createdAt, 30, createdAt)).toEqual({
      status: 'retry',
      startAfterMs: createdAt + 3_600_000,
    });
  });

  it('stops resending once the next attempt would leave Task receipt window', () => {
    const late = createdAt + gitMergeIntentWindowMs - 30_000;
    expect(decideGitMergeIntentRetry(createdAt, 2, late)).toEqual({ status: 'expired' });
    expect(gitMergeIntentWindowMs).toBe(24 * 60 * 60 * 1_000);
  });
});
