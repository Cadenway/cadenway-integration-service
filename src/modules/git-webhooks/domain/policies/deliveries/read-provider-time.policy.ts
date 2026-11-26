const ISO_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
// GitLab pipeline payloads write their times as `2026-11-08 20:18:44 UTC`.
const GITLAB_UTC_TIMESTAMP =
  /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d) UTC$/u;

/**
 * Reads a signed provider timestamp as Unix milliseconds, or null when it is absent, malformed
 * or names an impossible calendar date. Provider times order deliveries per link member
 * ("Ordering", Integration AsyncAPI).
 */
export function readProviderTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const gitlab = GITLAB_UTC_TIMESTAMP.exec(value);
  const iso = gitlab === null ? value : `${gitlab[1] ?? ''}T${gitlab[2] ?? ''}Z`;
  if (!ISO_TIMESTAMP.test(iso)) return null;

  const parsed = Date.parse(iso);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;

  // Date.parse can normalize invalid calendar dates, including February 30.
  const localTime = iso.slice(0, 19);
  return new Date(`${localTime}Z`).toISOString().startsWith(localTime) ? parsed : null;
}
