/** Bounds the lifetime of a receipt and its dependent checks. */
export const gitDispatchWindowMs = 60 * 60 * 1_000;

/** Reads the PostgreSQL receipt time embedded in an already verified UUIDv7. */
export function gitDispatchReceiptTimeMs(id: string): number {
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** Resolves a check's dependencies against its own receipt deadline. */
export function decideGitCheckPrerequisites(
  receiptId: string,
  predecessors: readonly { readonly id: string; readonly observesHead: boolean }[],
  now: number,
):
  | { readonly status: 'ready' | 'closed' }
  | { readonly status: 'deferred'; readonly startAfter: Date } {
  const receiptTime = gitDispatchReceiptTimeMs(receiptId);
  const deadline = receiptTime + gitDispatchWindowMs;
  if (now >= deadline) return { status: 'closed' };

  let firstExpiration = Number.POSITIVE_INFINITY;
  let expiredHead = false;
  for (const predecessor of predecessors) {
    const expiration = gitDispatchReceiptTimeMs(predecessor.id) + gitDispatchWindowMs;
    if (expiration <= now) {
      expiredHead ||= predecessor.observesHead;
    } else {
      firstExpiration = Math.min(firstExpiration, expiration);
    }
  }

  if (!Number.isFinite(firstExpiration)) return { status: expiredHead ? 'closed' : 'ready' };

  // Replays in a polling slot enqueue the same occurrence. Wake by the first expiry.
  const interval = now - receiptTime < 30_000 ? 2_000 : 60_000;
  const nextPoll = (Math.floor(now / interval) + 1) * interval;
  const startAfter = Math.min(firstExpiration, nextPoll);
  return startAfter < deadline
    ? { status: 'deferred', startAfter: new Date(startAfter) }
    : { status: 'closed' };
}
