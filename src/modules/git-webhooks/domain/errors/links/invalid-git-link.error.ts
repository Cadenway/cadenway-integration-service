import { DomainError } from './domain.error.js';

/** Rejects contradictory or invalid Git link input without exposing provider data. */
export class InvalidGitLinkError extends DomainError {
  // #region Constructor
  /** Uses a fixed reason suitable for reporting a failed link decision. */
  public constructor() {
    super('The Git link decision could not be applied.');
    this.name = 'InvalidGitLinkError';
  }
  // #endregion
}
