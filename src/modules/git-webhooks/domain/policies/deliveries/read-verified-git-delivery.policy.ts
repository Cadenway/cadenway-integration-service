import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import type { VerifiedGitDelivery } from '../../value-objects/deliveries/verified-git-delivery.value-object.js';

type JsonObject = Readonly<Record<string, unknown>>;
type GitRequestHead = Extract<VerifiedGitDelivery, { trigger: 'pr_head' }>['head'];
type GitAutomation =
  | { readonly trigger: 'branch'; readonly branch: string }
  | {
      readonly trigger: 'pr_open' | 'pr_merged' | 'pr_closed';
      readonly requestNumber: number;
      readonly head?: GitRequestHead;
    };

// Reject an oversized action as a whole before it can fan out to Task.
const MAX_TASK_KEYS = 20;
// The documented GitLab Push Hook includes at most the latest twenty commits.
const MAX_GITLAB_PUSH_COMMITS = 20;
const BRANCH_REF_PREFIX = 'refs/heads/';
const ZERO_REVISION = /^(?:0{40}|0{64})$/u;
const COMMIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PROVIDER_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const CLOSING_VERBS = new Set(['fixes', 'closes', 'resolves']);
// Mirrors the TaskKey shape in cadenway-api-contracts/components/task.yaml.
const TASK_REFERENCE =
  /(?<![\p{L}\p{M}\p{N}_])(?:([A-Za-z]{5,8})\s+)?([A-Za-z]{2,5}-[1-9][0-9]{0,8})(?![\p{L}\p{M}\p{N}_])/gu;

/**
 * Reads automation facts from a JSON body already verified with the receiver's signing key.
 *
 * The Development panel (App.dc.html:4328–4360) links task references in branches, request text
 * or commits. Require both request repositories to belong to the receiver before using references.
 * The Integration AsyncAPI distinguishes a close without merge from a merge. Only a merge retains
 * explicit closing verbs as task status intent (cw-integration-domain). A source revision
 * change supplies an observation for existing links without discovering tasks from the text.
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

  const currentHead = readRequestHead(head?.sha, request.updated_at);
  const open = request.state === 'open' && (request.merged === false || request.merged === null);
  if (delivery.action === 'synchronize') {
    // GitHub's synchronize event includes the old and new revision of the PR head.
    if (!open || delivery.after !== currentHead?.sha) return { kind: 'ignored' };
    return observeHeadChange(requestNumber, currentHead, delivery.before);
  }

  // GitHub reports both kinds of closure through the closed action and distinguishes them by the merged flag.
  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
  const opened = delivery.action === 'opened' && open;
  const closed =
    delivery.action === 'closed' &&
    request.state === 'closed' &&
    typeof request.merged === 'boolean';
  if (!opened && !closed) {
    return { kind: 'ignored' };
  }

  const trigger = opened ? 'pr_open' : request.merged === true ? 'pr_merged' : 'pr_closed';
  return readTaskReferences(
    { trigger, requestNumber, ...(currentHead === undefined ? {} : { head: currentHead }) },
    [head?.ref, request.title, request.body],
  );
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
      !isCommitRevision(after) ||
      after.length !== before.length ||
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

  const lastCommit = asObject(request.last_commit);
  const currentHead = readRequestHead(lastCommit?.id, request.updated_at);
  if (request.action === 'update' && request.state === 'opened') {
    // GitLab includes oldrev on MR updates caused by actual changes to source code.
    return observeHeadChange(requestNumber, currentHead, request.oldrev);
  }

  const opened = request.action === 'open' && request.state === 'opened';
  const merged = request.action === 'merge' && request.state === 'merged';
  const closed = request.action === 'close' && request.state === 'closed';
  if (!opened && !merged && !closed) {
    return { kind: 'ignored' };
  }

  const trigger = opened ? 'pr_open' : merged ? 'pr_merged' : 'pr_closed';
  return readTaskReferences(
    { trigger, requestNumber, ...(currentHead === undefined ? {} : { head: currentHead }) },
    [request.source_branch, request.title, request.description, lastCommit?.message],
  );
}

function readRequestHead(sha: unknown, updatedAt: unknown): GitRequestHead | undefined {
  if (
    !isCommitRevision(sha) ||
    typeof updatedAt !== 'string' ||
    !PROVIDER_TIMESTAMP.test(updatedAt)
  ) {
    return undefined;
  }

  const observedAtMs = Date.parse(updatedAt);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 1) return undefined;

  // Reject dates the runtime silently rolls into the next calendar month.
  const localTime = updatedAt.slice(0, 19);
  if (!new Date(`${localTime}Z`).toISOString().startsWith(localTime)) return undefined;

  return { sha, observedAtMs };
}

function observeHeadChange(
  requestNumber: number,
  head: GitRequestHead | undefined,
  previousSha: unknown,
): VerifiedGitDelivery {
  if (head === undefined || !isCommitRevision(previousSha) || previousSha === head.sha) {
    return { kind: 'ignored' };
  }
  return {
    kind: 'actionable',
    trigger: 'pr_head',
    requestNumber,
    head,
    taskKeys: [],
    closingTaskKeys: [],
  };
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

  if (taskKeys.size === 0 && automation.trigger !== 'pr_closed') return { kind: 'ignored' };

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

function isCommitRevision(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_REVISION.test(value) && !ZERO_REVISION.test(value);
}
