/**
 * Window in which Task keeps the receipt of a command (`TaskActionIdempotencyKey`, Task internal
 * contract: at least 24 hours), counted from the creation of the merge intent, which precedes its
 * first submission.
 */
export const gitMergeIntentWindowMs = 24 * 60 * 60 * 1_000;

const firstRetryDelayMs = 60 * 1_000;
const maxRetryDelayMs = 60 * 60 * 1_000;

/**
 * Schedules the next submission of an unconfirmed merge intent ("Merge intent", Integration
 * AsyncAPI): retries back off from one minute, doubling up to one hour, under the same command
 * identity. A command whose next submission would fall outside Task's receipt window is not
 * resent: it stays `pending` for operator follow-up.
 *
 * @param createdAtMs - Creation of the intent, in Unix milliseconds.
 * @param attempts - Submissions already made, at least one.
 * @param nowMs - Current database time, in Unix milliseconds.
 */
export function decideGitMergeIntentRetry(
  createdAtMs: number,
  attempts: number,
  nowMs: number,
): { readonly status: 'retry'; readonly startAfterMs: number } | { readonly status: 'expired' } {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 16);
  const delay = Math.min(firstRetryDelayMs * 2 ** exponent, maxRetryDelayMs);
  const startAfterMs = nowMs + delay;
  return startAfterMs < createdAtMs + gitMergeIntentWindowMs
    ? { status: 'retry', startAfterMs }
    : { status: 'expired' };
}
