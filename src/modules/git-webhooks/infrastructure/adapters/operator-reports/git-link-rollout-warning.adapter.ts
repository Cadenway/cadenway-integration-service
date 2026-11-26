import { Logger } from '@nestjs/common';

/**
 * Reminds operators of the link rollout rule at start-up: link recording must stay off whenever
 * an earlier release runs beside this one, during a rolling replacement or a rollback
 * (docs/development.md, "Git link rollout"). Logs no configuration value.
 */
export class GitLinkRolloutWarning {
  // #region Properties
  /** Writes through the service's structured logger. */
  private readonly logger = new Logger('GitLinkRollout');
  // #endregion

  // #region Methods
  /** Warns once when link recording is on. */
  public report(linkEventsEnabled: boolean): void {
    if (!linkEventsEnabled) return;
    this.logger.warn(
      { reason: 'git-link-events-rollout' },
      'Git link recording is on: keep it off while an earlier release runs beside this one',
    );
  }
  // #endregion
}
