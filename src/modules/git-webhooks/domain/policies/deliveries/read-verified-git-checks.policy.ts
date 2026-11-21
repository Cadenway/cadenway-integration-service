import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import type { VerifiedGitChecksCorrelation } from '../../value-objects/deliveries/verified-git-checks-correlation.value-object.js';

type JsonObject = Readonly<Record<string, unknown>>;

const GITHUB_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
]);
const GITLAB_TERMINAL_STATUSES = new Set(['canceled', 'failed', 'skipped', 'success']);
const COMMIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PROVIDER_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/**
 * Reads a check correlation from an authenticated webhook for the receiver's repository.
 * GitHub's check suite and GitLab's pipeline webhooks provide one verified PR or MR candidate.
 * Integration AsyncAPI requires an authorized linked task, so the caller must match the
 * stored link and its current revision before applying any result.
 *
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_suite
 * https://docs.gitlab.com/user/project/integrations/webhook_events/#pipeline-events
 */
export function readVerifiedGitChecks(
  binding: GitReceiverBinding,
  body: unknown,
): VerifiedGitChecksCorrelation | null {
  const delivery = asObject(body);
  if (delivery === undefined) return null;

  return binding.provider === 'github'
    ? readGitHubSuite(binding, delivery)
    : readGitLabPipeline(binding.repositoryId, delivery);
}

function readGitHubSuite(
  { repositoryId, installationId }: Extract<GitReceiverBinding, { provider: 'github' }>,
  delivery: JsonObject,
): VerifiedGitChecksCorrelation | null {
  if (
    delivery.action !== 'completed' ||
    !matchesId(asObject(delivery.repository)?.id, repositoryId) ||
    !matchesId(asObject(delivery.installation)?.id, installationId)
  ) {
    return null;
  }

  const suite = asObject(delivery.check_suite);
  if (
    suite === undefined ||
    !isProviderId(suite.id) ||
    suite.status !== 'completed' ||
    typeof suite.conclusion !== 'string' ||
    !GITHUB_CONCLUSIONS.has(suite.conclusion) ||
    !isRevision(suite.head_sha) ||
    typeof suite.head_branch !== 'string' ||
    suite.head_branch.length === 0 ||
    !Array.isArray(suite.pull_requests) ||
    suite.pull_requests.length !== 1
  ) {
    return null;
  }

  const request = asObject(suite.pull_requests[0]);
  const head = asObject(request?.head);
  const base = asObject(request?.base);
  const completedAtMs = providerTimestamp(suite.updated_at);
  if (
    !isProviderId(request?.number) ||
    head?.ref !== suite.head_branch ||
    head.sha !== suite.head_sha ||
    !matchesId(asObject(head.repo)?.id, repositoryId) ||
    !matchesId(asObject(base?.repo)?.id, repositoryId) ||
    completedAtMs === null
  ) {
    return null;
  }

  return {
    requestNumber: request.number,
    headSha: suite.head_sha,
    attemptId: suite.id,
    completedAtMs,
  };
}

function readGitLabPipeline(
  repositoryId: number,
  delivery: JsonObject,
): VerifiedGitChecksCorrelation | null {
  if (
    delivery.object_kind !== 'pipeline' ||
    !matchesId(asObject(delivery.project)?.id, repositoryId)
  ) {
    return null;
  }

  const pipeline = asObject(delivery.object_attributes);
  const request = asObject(delivery.merge_request);
  const completedAtMs = providerTimestamp(pipeline?.finished_at);
  if (
    pipeline === undefined ||
    !isProviderId(pipeline.id) ||
    pipeline.source !== 'merge_request_event' ||
    pipeline.tag !== false ||
    typeof pipeline.status !== 'string' ||
    !GITLAB_TERMINAL_STATUSES.has(pipeline.status) ||
    !isRevision(pipeline.sha) ||
    asObject(delivery.commit)?.id !== pipeline.sha ||
    !isProviderId(request?.iid) ||
    !matchesId(request.source_project_id, repositoryId) ||
    !matchesId(request.target_project_id, repositoryId) ||
    completedAtMs === null
  ) {
    return null;
  }

  return {
    requestNumber: request.iid,
    headSha: pipeline.sha,
    attemptId: pipeline.id,
    completedAtMs,
  };
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function isProviderId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function matchesId(value: unknown, expected: number): boolean {
  return isProviderId(value) && value === expected;
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_REVISION.test(value) && /[1-9a-f]/u.test(value);
}

function providerTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !PROVIDER_TIMESTAMP.test(value)) return null;

  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;

  // Date.parse can normalize invalid calendar dates, including February 30.
  const localTime = value.slice(0, 19);
  return new Date(`${localTime}Z`).toISOString().startsWith(localTime) ? parsed : null;
}
