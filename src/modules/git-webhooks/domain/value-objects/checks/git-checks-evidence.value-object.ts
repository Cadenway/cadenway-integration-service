import type { GitCheckObservation } from './git-check-observation.value-object.js';

type GitHubStatus = Extract<GitCheckObservation, { provider: 'github' }>['status'];
type GitLabStatus = Extract<GitCheckObservation, { provider: 'gitlab' }>['status'];

/**
 * Everything the aggregate of one head needs from its stored observations, whatever their number:
 * GitHub suites counted per status and conclusion, or the GitLab pipeline with the highest ID.
 * The completion time is the latest provider completion among the counted observations.
 */
export type GitChecksEvidence =
  | {
      readonly provider: 'github';
      readonly suites: readonly {
        readonly status: GitHubStatus;
        readonly conclusion: string | null;
        readonly count: number;
        readonly completedAtMs: number | null;
      }[];
    }
  | {
      readonly provider: 'gitlab';
      readonly latest: {
        readonly attemptId: number;
        readonly status: GitLabStatus;
        readonly jobTotal?: number;
        readonly jobFailed?: number;
      };
      readonly completedAtMs: number | null;
    };
