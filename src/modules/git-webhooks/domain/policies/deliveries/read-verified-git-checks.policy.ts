import type { GitCheckObservation } from '../../value-objects/checks/git-check-observation.value-object.js';
import type { VerifiedGitChecks } from '../../value-objects/checks/verified-git-checks.value-object.js';
import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import { readProviderTime } from './read-provider-time.policy.js';

type JsonObject = Readonly<Record<string, unknown>>;
type GitHubStatus = Extract<GitCheckObservation, { provider: 'github' }>['status'];
type GitLabStatus = Extract<GitCheckObservation, { provider: 'gitlab' }>['status'];

const GITHUB_ACTIONS = new Set(['completed', 'requested', 'rerequested']);
const GITHUB_STATUSES = new Set<string>([
  'requested',
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'completed',
]);
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
const GITLAB_STATUSES = new Set<string>([
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
]);
const GITLAB_TERMINAL_STATUSES = new Set(['canceled', 'failed', 'skipped', 'success']);
const COMMIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Reads a check observation from an authenticated webhook for the receiver's repository.
 * GitHub's `check_suite` (`requested`, `rerequested` and `completed`) and GitLab's merge request
 * `Pipeline Hook` (any documented status) are stored per repository, head SHA and suite or
 * pipeline ("Checks", Integration AsyncAPI). A request is named only when the provider lists
 * exactly one in the receiver's repository; the caller must still match the stored link and its
 * current head before projecting the aggregate.
 *
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_suite
 * https://docs.gitlab.com/user/project/integrations/webhook_events/#pipeline-events
 */
export function readVerifiedGitChecks(
  binding: GitReceiverBinding,
  body: unknown,
): VerifiedGitChecks | null {
  const delivery = asObject(body);
  if (delivery === undefined) return null;

  return binding.provider === 'github'
    ? readGitHubSuite(binding, delivery)
    : readGitLabPipeline(binding.repositoryId, delivery);
}

function readGitHubSuite(
  { repositoryId, installationId }: Extract<GitReceiverBinding, { provider: 'github' }>,
  delivery: JsonObject,
): VerifiedGitChecks | null {
  if (
    typeof delivery.action !== 'string' ||
    !GITHUB_ACTIONS.has(delivery.action) ||
    !matchesId(asObject(delivery.repository)?.id, repositoryId) ||
    !matchesId(asObject(delivery.installation)?.id, installationId)
  ) {
    return null;
  }

  const suite = asObject(delivery.check_suite);
  const observedAtMs = providerTime(suite?.updated_at);
  if (
    suite === undefined ||
    !isProviderId(suite.id) ||
    typeof suite.status !== 'string' ||
    !GITHUB_STATUSES.has(suite.status) ||
    (delivery.action === 'completed') !== (suite.status === 'completed') ||
    !isRevision(suite.head_sha) ||
    observedAtMs === null
  ) {
    return null;
  }
  const completed = suite.status === 'completed';
  if (
    completed
      ? typeof suite.conclusion !== 'string' || !GITHUB_CONCLUSIONS.has(suite.conclusion)
      : suite.conclusion !== null && suite.conclusion !== undefined
  ) {
    return null;
  }

  const observation: GitCheckObservation = {
    provider: 'github',
    attemptId: suite.id,
    headSha: suite.head_sha,
    observedAtMs,
    completedAtMs: completed ? observedAtMs : null,
    status: suite.status as GitHubStatus,
    conclusion: completed ? (suite.conclusion as string) : null,
  };
  const requests = Array.isArray(suite.pull_requests) ? suite.pull_requests : [];
  const request = requests.length === 1 ? asObject(requests[0]) : undefined;
  const head = asObject(request?.head);
  const base = asObject(request?.base);
  if (
    !isProviderId(request?.number) ||
    typeof suite.head_branch !== 'string' ||
    suite.head_branch.length === 0 ||
    head?.ref !== suite.head_branch ||
    head.sha !== suite.head_sha ||
    !matchesId(asObject(head.repo)?.id, repositoryId) ||
    !matchesId(asObject(base?.repo)?.id, repositoryId)
  ) {
    return { observation };
  }
  return { observation, request: { number: request.number } };
}

function readGitLabPipeline(repositoryId: number, delivery: JsonObject): VerifiedGitChecks | null {
  if (
    delivery.object_kind !== 'pipeline' ||
    !matchesId(asObject(delivery.project)?.id, repositoryId)
  ) {
    return null;
  }

  const pipeline = asObject(delivery.object_attributes);
  const request = asObject(delivery.merge_request);
  const status = pipeline?.status;
  if (
    pipeline === undefined ||
    !isProviderId(pipeline.id) ||
    pipeline.source !== 'merge_request_event' ||
    pipeline.tag !== false ||
    typeof status !== 'string' ||
    !GITLAB_STATUSES.has(status) ||
    !isRevision(pipeline.sha) ||
    asObject(delivery.commit)?.id !== pipeline.sha ||
    !isProviderId(request?.iid) ||
    !matchesId(request.source_project_id, repositoryId) ||
    !matchesId(request.target_project_id, repositoryId)
  ) {
    return null;
  }

  const jobs = Array.isArray(delivery.builds) ? delivery.builds.map(asObject) : undefined;
  // A finished pipeline is ordered by its completion. A running one keeps its ID when GitLab
  // retries it, so it is ordered by the latest job time, which advances past that completion.
  const terminal = GITLAB_TERMINAL_STATUSES.has(status);
  const completedAtMs = terminal ? providerTime(pipeline.finished_at) : null;
  const observedAtMs = terminal ? completedAtMs : latestTime(pipeline.created_at, jobs ?? []);
  if (observedAtMs === null) return null;

  const observation: GitCheckObservation = {
    provider: 'gitlab',
    attemptId: pipeline.id,
    headSha: pipeline.sha,
    observedAtMs,
    completedAtMs,
    status: status as GitLabStatus,
    ...(jobs === undefined
      ? {}
      : {
          jobTotal: jobs.length,
          jobFailed: jobs.filter((job) => job?.status === 'failed').length,
        }),
  };
  const state =
    request.state === 'opened'
      ? 'open'
      : request.state === 'closed' || request.state === 'merged'
        ? request.state
        : undefined;
  return {
    observation,
    request: {
      number: request.iid,
      ...(state === undefined ? {} : { state: { state, observedAtMs } }),
    },
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

function providerTime(value: unknown): number | null {
  return readProviderTime(value);
}

/** Latest of the pipeline creation and its jobs' creation, start and finish times. */
function latestTime(createdAt: unknown, jobs: readonly (JsonObject | undefined)[]): number | null {
  const created = providerTime(createdAt);
  if (created === null) return null;
  let latest = created;
  for (const job of jobs) {
    for (const time of [job?.created_at, job?.started_at, job?.finished_at]) {
      const parsed = providerTime(time);
      if (parsed !== null) latest = Math.max(latest, parsed);
    }
  }
  return latest;
}
