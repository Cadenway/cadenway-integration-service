import { describe, expect, it } from 'vitest';

import {
  decideGitCheckPrerequisites,
  gitDispatchWindowMs,
} from './git-check-prerequisites.model.js';

const now = Date.UTC(2026, 10, 22, 10);

function receipt(time: number): string {
  const hex = time.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
}

describe('Git check prerequisites', () => {
  it('provides another stable polling slot after the original retry horizon', () => {
    const check = receipt(now - 30 * 60_000);
    const predecessors = [{ id: receipt(now - 45 * 60_000), observesHead: true }];
    const expected = { status: 'deferred', startAfter: new Date(now + 60_000) };

    expect(decideGitCheckPrerequisites(check, predecessors, now)).toEqual(expected);
    expect(decideGitCheckPrerequisites(check, predecessors, now + 1)).toEqual(expected);
    expect(decideGitCheckPrerequisites(check, predecessors, now + 60_000)).toEqual({
      status: 'deferred',
      startAfter: new Date(now + 120_000),
    });
  });

  it('revisits the exact predecessor expiry when it comes before the next poll', () => {
    const check = receipt(now - 30 * 60_000);
    const expiresIn = 5_899;
    const predecessors = [
      { id: receipt(now - gitDispatchWindowMs + expiresIn), observesHead: true },
    ];

    expect(decideGitCheckPrerequisites(check, predecessors, now)).toEqual({
      status: 'deferred',
      startAfter: new Date(now + expiresIn),
    });
    expect(decideGitCheckPrerequisites(check, predecessors, now + expiresIn)).toEqual({
      status: 'closed',
    });
    expect(decideGitCheckPrerequisites(check, [], now + expiresIn)).toEqual({ status: 'ready' });
  });

  it('releases an expired predecessor without any recorded head observation', () => {
    const check = receipt(now - 30 * 60_000);
    const predecessors = [{ id: receipt(now - gitDispatchWindowMs), observesHead: false }];

    expect(decideGitCheckPrerequisites(check, predecessors, now)).toEqual({ status: 'ready' });
  });

  it('does not overlook a live predecessor with the same receipt timestamp', () => {
    const checkTime = now - gitDispatchWindowMs + 25_000;
    const check = receipt(checkTime);
    const predecessor = receipt(checkTime).replace(/1$/u, '2');

    expect(
      decideGitCheckPrerequisites(check, [{ id: predecessor, observesHead: true }], now),
    ).toEqual({ status: 'closed' });
  });

  it('does not schedule work for a check that has itself expired', () => {
    const check = receipt(now - gitDispatchWindowMs);

    expect(decideGitCheckPrerequisites(check, [], now)).toEqual({ status: 'closed' });
  });
});
