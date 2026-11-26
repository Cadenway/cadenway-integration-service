import type { GitChecksAggregate } from '../../../domain/value-objects/checks/git-checks-aggregate.value-object.js';
import type { GitLinkMembers } from '../../../domain/value-objects/links/git-link-members.value-object.js';
import type { GitLinkSource } from '../../../domain/value-objects/links/git-link-source.value-object.js';

/**
 * One link of a task as `listTaskGitLinksInternal` returns it (`GitLink`, Integration contract).
 * Optional members are absent until a delivery recorded them.
 */
export interface TaskGitLink extends GitLinkMembers {
  // #region Properties
  /** Stable link ID, task key and provider identity. */
  readonly id: string;
  readonly taskKey: string;
  readonly provider: 'github' | 'gitlab';
  readonly kind: 'branch' | 'pull-request';
  readonly state: 'branch' | 'open' | 'merged' | 'closed';
  readonly providerRepositoryId: number;
  readonly number: number | null;
  readonly branch: string | null;

  /** Current head and the latest completion of its checks. */
  readonly headSha: string | null;
  readonly checksCompletedAt: string | null;
  readonly checks?: GitChecksAggregate;

  /** Record times and the version of the latest fact. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;

  /** Where the task key was found when the link was created. */
  readonly linkSource?: GitLinkSource;
  // #endregion
}
