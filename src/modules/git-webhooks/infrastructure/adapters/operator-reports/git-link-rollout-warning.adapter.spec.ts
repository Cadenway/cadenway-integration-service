import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitLinkRolloutWarning } from './git-link-rollout-warning.adapter.js';

describe('GitLinkRolloutWarning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns while link recording is on, as the rollout rule requires', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new GitLinkRolloutWarning().report(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toEqual({ reason: 'git-link-events-rollout' });
  });

  it('stays silent while link recording is off', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new GitLinkRolloutWarning().report(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
