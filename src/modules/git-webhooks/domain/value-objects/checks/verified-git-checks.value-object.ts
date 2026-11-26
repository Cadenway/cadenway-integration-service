import type { VerifiedGitRequestState } from '../deliveries/verified-git-request-state.value-object.js';
import type { GitCheckObservation } from './git-check-observation.value-object.js';

/**
 * A verified check suite or merge request pipeline observation, and the single request the
 * provider names for it, when it names exactly one in the receiver's repository.
 */
export interface VerifiedGitChecks {
  // #region Properties
  /** Stored per repository and head whether or not a link exists yet. */
  readonly observation: GitCheckObservation;

  /** Request number and, for a GitLab pipeline, the request's reported state. */
  readonly request?: {
    readonly number: number;
    readonly state?: VerifiedGitRequestState;
  };
  // #endregion
}
