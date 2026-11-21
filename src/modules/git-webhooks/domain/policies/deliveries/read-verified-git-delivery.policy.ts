import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import type { VerifiedGitDelivery } from '../../value-objects/deliveries/verified-git-delivery.value-object.js';

type JsonObject = Readonly<Record<string, unknown>>;
type GitAutomation =
  | { readonly trigger: 'branch'; readonly branch: string }
  | {
      readonly trigger: 'pr_open' | 'pr_merged';
      readonly requestNumber: number;
    };

// Reject an oversized action as a whole before it can fan out to Task.
const MAX_TASK_KEYS = 20;
// The documented GitLab Push Hook includes at most the latest twenty commits.
const MAX_GITLAB_PUSH_COMMITS = 20;
const BRANCH_REF_PREFIX = 'refs/heads/';
const ZERO_REVISION = /^(?:0{40}|0{64})$/u;
const COMMIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CLOSING_VERBS = new Set(['fixes', 'closes', 'resolves']);
// Mirrors the TaskKey shape in cadenway-api-contracts/components/task.yaml.
const TASK_REFERENCE =
  /(?<![\p{L}\p{M}\p{N}_])(?:([A-Za-z]{5,8})\s+)?([A-Za-z]{2,5}-[1-9][0-9]{0,8})(?![\p{L}\p{M}\p{N}_])/gu;

/**
 * Reads automation facts from a JSON body already verified with the receiver's signing key.
 *
 * The Development panel (App.dc.html:4328–4360) maps a new branch, open PR or MR, and merged PR or MR
 * to distinct triggers, with task references in branches, request text or commits. Require the
 * source and destination request repositories to belong to the receiver before using any reference.
 * A merged request retains explicit closing verbs as candidate intent (cw-integration-domain).
 * The caller owns replay protection, space authorization and the status transition.
 */
export function readVerifiedGitDelivery(
  binding: GitReceiverBinding,
  body: unknown,
): VerifiedGitDelivery {
  const delivery = asObject(body);
  if (binding.provider === 'github') {
    if (
      !delivery ||
      !matchesId(asObject(delivery.repository)?.id, binding.repositoryId) ||
      !matchesId(asObject(delivery.installation)?.id, binding.installationId)
    ) {
      return { kind: 'repository_mismatch' };
    }
    return readGitHubDelivery(delivery, binding.repositoryId);
  }

  if (
    !delivery ||
    !matchesId(asObject(delivery.project)?.id, binding.repositoryId) ||
    (delivery.object_kind === 'push' && !matchesId(delivery.project_id, binding.repositoryId))
  ) {
    return { kind: 'repository_mismatch' };
  }
  return readGitLabDelivery(delivery, binding.repositoryId);
}

function readGitHubDelivery(delivery: JsonObject, repositoryId: number): VerifiedGitDelivery {
  // GitHub's create payload has master_branch. The delete payload shares ref and ref_type.
  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#create
  if (
    delivery.action === undefined &&
    typeof delivery.master_branch === 'string' &&
    delivery.master_branch.length !== 0 &&
    delivery.ref_type === 'branch' &&
    typeof delivery.ref === 'string' &&
    delivery.ref.length !== 0
  ) {
    return readTaskReferences({ trigger: 'branch', branch: delivery.ref }, [delivery.ref]);
  }

  const request = asObject(delivery.pull_request);
  const head = asObject(request?.head);
  const base = asObject(request?.base);
  const requestNumber = delivery.number;
  if (
    !request ||
    !isProviderId(requestNumber) ||
    request.number !== requestNumber ||
    !matchesId(asObject(head?.repo)?.id, repositoryId) ||
    !matchesId(asObject(base?.repo)?.id, repositoryId)
  ) {
    return { kind: 'ignored' };
  }

  // GitHub reports a merge as a closed pull_request with the merged flag set.
  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
  const opened =
    delivery.action === 'opened' &&
    request.state === 'open' &&
    (request.merged === false || request.merged === null);
  const merged =
    delivery.action === 'closed' && request.state === 'closed' && request.merged === true;
  if (!opened && !merged) {
    return { kind: 'ignored' };
  }

  return readTaskReferences({ trigger: opened ? 'pr_open' : 'pr_merged', requestNumber }, [
    head?.ref,
    request.title,
    request.body,
  ]);
}

function readGitLabDelivery(delivery: JsonObject, repositoryId: number): VerifiedGitDelivery {
  // https://docs.gitlab.com/user/project/integrations/webhook_events/#push-events
  if (delivery.object_kind === 'push' && delivery.event_name === 'push') {
    const { ref, before, after, commits } = delivery;
    if (
      typeof ref !== 'string' ||
      !ref.startsWith(BRANCH_REF_PREFIX) ||
      ref.length === BRANCH_REF_PREFIX.length ||
      typeof before !== 'string' ||
      !ZERO_REVISION.test(before) ||
      typeof after !== 'string' ||
      after.length !== before.length ||
      !COMMIT_REVISION.test(after) ||
      ZERO_REVISION.test(after) ||
      !Array.isArray(commits) ||
      commits.length > MAX_GITLAB_PUSH_COMMITS
    ) {
      return { kind: 'ignored' };
    }

    const branch = ref.slice(BRANCH_REF_PREFIX.length);
    return readTaskReferences({ trigger: 'branch', branch }, [
      branch,
      ...commits.map((commit: unknown) => asObject(commit)?.message),
    ]);
  }

  // https://docs.gitlab.com/user/project/integrations/webhook_events/#merge-request-events
  const request = asObject(delivery.object_attributes);
  const requestNumber = request?.iid;
  if (
    delivery.object_kind !== 'merge_request' ||
    delivery.event_type !== 'merge_request' ||
    !request ||
    !isProviderId(requestNumber) ||
    !matchesId(request.source_project_id, repositoryId) ||
    !matchesId(request.target_project_id, repositoryId)
  ) {
    return { kind: 'ignored' };
  }

  const opened = request.action === 'open' && request.state === 'opened';
  const merged = request.action === 'merge' && request.state === 'merged';
  if (!opened && !merged) {
    return { kind: 'ignored' };
  }

  return readTaskReferences({ trigger: opened ? 'pr_open' : 'pr_merged', requestNumber }, [
    request.source_branch,
    request.title,
    request.description,
    asObject(request.last_commit)?.message,
  ]);
}

function readTaskReferences(
  automation: GitAutomation,
  sources: readonly unknown[],
): VerifiedGitDelivery {
  const taskKeys = new Set<string>();
  const closingTaskKeys = new Set<string>();
  for (const source of sources) {
    if (typeof source !== 'string') continue;

    for (const [, verb, reference] of source.matchAll(TASK_REFERENCE)) {
      if (reference === undefined) continue;

      const key = reference.toUpperCase();
      taskKeys.add(key);
      if (taskKeys.size > MAX_TASK_KEYS) return { kind: 'ignored' };

      if (automation.trigger === 'pr_merged' && verb && CLOSING_VERBS.has(verb.toLowerCase())) {
        closingTaskKeys.add(key);
      }
    }
  }

  if (taskKeys.size === 0) return { kind: 'ignored' };

  return {
    kind: 'actionable',
    ...automation,
    taskKeys: [...taskKeys],
    closingTaskKeys: [...closingTaskKeys],
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
