import type { GitCheckObservation } from '../../value-objects/checks/git-check-observation.value-object.js';

/**
 * Decides whether a verified observation replaces the one stored for the same suite or
 * pipeline. Per "Ordering" and "Checks" in the Integration AsyncAPI, an older observation is
 * ignored and one with an equal provider time is applied in arrival order.
 */
export function replacesGitCheckObservation(
  stored: GitCheckObservation | null,
  next: GitCheckObservation,
): boolean {
  return stored === null || next.observedAtMs >= stored.observedAtMs;
}
