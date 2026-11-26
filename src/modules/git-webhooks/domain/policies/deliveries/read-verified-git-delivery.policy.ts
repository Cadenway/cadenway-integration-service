import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import type { VerifiedGitDelivery } from '../../value-objects/deliveries/verified-git-delivery.value-object.js';
import type { VerifiedGitRequestSnapshot } from '../../value-objects/deliveries/verified-git-request-snapshot.value-object.js';
import type { VerifiedGitRequestState } from '../../value-objects/deliveries/verified-git-request-state.value-object.js';
import type { GitLinkMembers } from '../../value-objects/links/git-link-members.value-object.js';
import type { GitLinkSource } from '../../value-objects/links/git-link-source.value-object.js';
import { readProviderTime } from './read-provider-time.policy.js';

type JsonObject = Readonly<Record<string, unknown>>;
type GitRequestHead = Extract<VerifiedGitDelivery, { trigger: 'pr_head' }>['head'];
type GitAutomation =
  | { readonly trigger: 'branch'; readonly branch: string; readonly members: GitLinkMembers }
  | {
      readonly trigger: 'pr_open' | 'pr_merged' | 'pr_closed' | 'pr_reopened';
      readonly requestNumber: number;
      readonly head?: GitRequestHead;
      readonly request?: VerifiedGitRequestSnapshot;
    };
type TaskReferenceSource = readonly [GitLinkSource, unknown];

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
// GitHub pull_request actions that only report the request's current members and state.
const GITHUB_UPDATES = new Set([
  'edited',
  'ready_for_review',
  'converted_to_draft',
  'review_requested',
  'review_request_removed',
]);

/**
 * Reads automation facts from a JSON body already verified with the receiver's signing key.
 *
 * The Development panel (App.dc.html:4328–4360) links task references in branches, request text
 * or commits. Require both request repositories to belong to the receiver before using references.
 * The Integration AsyncAPI distinguishes a close without merge from a merge. Only a merge retains
 * explicit closing verbs as task status intent (cw-integration-domain). A reopen, an edit, a draft
 * or review change and a source revision change update existing links without discovering tasks
 * from the text. Every request delivery also reports the request's current state and the `GitLink`
 * members it carries, at the request's provider time (`updated_at`), for the ordering rules.
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
  const repository = githubRepository(delivery.repository);
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
    const sender = githubAuthor(delivery.sender);
    const url =
      repository === undefined ? undefined : webUrl(`${repository.url}/tree/${delivery.ref}`);
    return readTaskReferences(
      {
        trigger: 'branch',
        branch: delivery.ref,
        members: compact({ repository, url, author: sender }),
      },
      [['branch', delivery.ref]],
    );
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
  const snapshot = githubSnapshot(request, head, repository);
  const open = request.state === 'open' && (request.merged === false || request.merged === null);
  if (delivery.action === 'synchronize') {
    // GitHub's synchronize event includes the old and new revision of the PR head.
    if (!open || delivery.after !== currentHead?.sha) return { kind: 'ignored' };
    return observeRequestUpdate(requestNumber, currentHead, snapshot, delivery.before);
  }
  if (typeof delivery.action === 'string' && GITHUB_UPDATES.has(delivery.action)) {
    return observeRequestUpdate(requestNumber, currentHead, snapshot);
  }

  // GitHub reports both kinds of closure through the closed action and distinguishes them by the merged flag.
  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
  const opened = delivery.action === 'opened' && open;
  const reopened = delivery.action === 'reopened' && open;
  const closed =
    delivery.action === 'closed' &&
    request.state === 'closed' &&
    typeof request.merged === 'boolean';
  if (!opened && !reopened && !closed) {
    return { kind: 'ignored' };
  }

  const trigger = opened
    ? 'pr_open'
    : reopened
      ? 'pr_reopened'
      : request.merged === true
        ? 'pr_merged'
        : 'pr_closed';
  return readTaskReferences(
    {
      trigger,
      requestNumber,
      ...(currentHead === undefined ? {} : { head: currentHead }),
      ...(snapshot === undefined ? {} : { request: snapshot }),
    },
    [
      ['branch', head?.ref],
      ['title', request.title],
      ['description', request.body],
    ],
  );
}

function readGitLabDelivery(delivery: JsonObject, repositoryId: number): VerifiedGitDelivery {
  const project = gitlabRepository(delivery.project);
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
    const author = providerAuthor(delivery.user_username, delivery.user_name);
    const url = project === undefined ? undefined : webUrl(`${project.url}/-/tree/${branch}`);
    return readTaskReferences(
      { trigger: 'branch', branch, members: compact({ repository: project, url, author }) },
      [
        ['branch', branch],
        ...commits.map((commit: unknown): TaskReferenceSource => [
          'commit',
          asObject(commit)?.message,
        ]),
      ],
    );
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
  const snapshot = gitlabSnapshot(delivery, request, project);
  if (request.action === 'update') {
    // GitLab includes oldrev on MR updates caused by actual changes to source code.
    if (request.oldrev !== undefined) {
      return observeRequestUpdate(requestNumber, currentHead, snapshot, request.oldrev);
    }
    return observeRequestUpdate(requestNumber, currentHead, snapshot);
  }

  const opened = request.action === 'open' && request.state === 'opened';
  const reopened = request.action === 'reopen' && request.state === 'opened';
  const merged = request.action === 'merge' && request.state === 'merged';
  const closed = request.action === 'close' && request.state === 'closed';
  if (!opened && !reopened && !merged && !closed) {
    return { kind: 'ignored' };
  }

  const trigger = opened
    ? 'pr_open'
    : reopened
      ? 'pr_reopened'
      : merged
        ? 'pr_merged'
        : 'pr_closed';
  return readTaskReferences(
    {
      trigger,
      requestNumber,
      ...(currentHead === undefined ? {} : { head: currentHead }),
      ...(snapshot === undefined ? {} : { request: snapshot }),
    },
    [
      ['branch', request.source_branch],
      ['title', request.title],
      ['description', request.description],
      ['commit', lastCommit?.message],
    ],
  );
}

/** Reports GitHub's current state and members; `merged` is decisive once the request is closed. */
function githubSnapshot(
  request: JsonObject,
  head: JsonObject | undefined,
  repository: GitLinkMembers['repository'],
): VerifiedGitRequestSnapshot | undefined {
  const state =
    request.state === 'open' && request.merged !== true
      ? 'open'
      : request.state === 'closed' && request.merged === true
        ? 'merged'
        : request.state === 'closed' && request.merged === false
          ? 'closed'
          : undefined;
  if (state === undefined) return undefined;
  const reviewers = [request.requested_reviewers, request.requested_teams].filter(Array.isArray);
  return {
    state: { state, observedAtMs: readProviderTime(request.updated_at) },
    members: compact({
      title: nonEmpty(request.title),
      draft: typeof request.draft === 'boolean' ? request.draft : undefined,
      url: webUrl(request.html_url),
      repository,
      sourceBranch: nonEmpty(head?.ref),
      author: githubAuthor(request.user),
      reviewRequested:
        reviewers.length === 0 ? undefined : reviewers.some((list) => list.length !== 0),
      additions: lineCount(request.additions),
      deletions: lineCount(request.deletions),
    }),
  };
}

/** Reports GitLab's state and members; its `user` is the opener only on the opening delivery. */
function gitlabSnapshot(
  delivery: JsonObject,
  request: JsonObject,
  repository: GitLinkMembers['repository'],
): VerifiedGitRequestSnapshot | undefined {
  const state = gitlabRequestState(request.state);
  if (state === undefined) return undefined;
  const user = asObject(delivery.user);
  return {
    state: { state, observedAtMs: readProviderTime(request.updated_at) },
    members: compact({
      title: nonEmpty(request.title),
      draft: typeof request.draft === 'boolean' ? request.draft : undefined,
      url: webUrl(request.url),
      repository,
      sourceBranch: nonEmpty(request.source_branch),
      author: request.action === 'open' ? providerAuthor(user?.username, user?.name) : undefined,
      reviewRequested: Array.isArray(delivery.reviewers)
        ? delivery.reviewers.length !== 0
        : undefined,
    }),
  };
}

/** Maps GitLab's merge request state; a locked request reports no lifecycle. */
function gitlabRequestState(value: unknown): VerifiedGitRequestState['state'] | undefined {
  if (value === 'opened') return 'open';
  if (value === 'closed' || value === 'merged') return value;
  return undefined;
}

function readRequestHead(sha: unknown, updatedAt: unknown): GitRequestHead | undefined {
  const observedAtMs = readProviderTime(updatedAt);
  if (!isCommitRevision(sha) || observedAtMs === null) return undefined;
  return { sha, observedAtMs };
}

/**
 * Admits a member or revision update for existing links. It needs the request's provider time to
 * be ordered. A revision change must also prove a different previous revision.
 */
function observeRequestUpdate(
  requestNumber: number,
  head: GitRequestHead | undefined,
  request: VerifiedGitRequestSnapshot | undefined,
  previousSha?: unknown,
): VerifiedGitDelivery {
  if (request === undefined || request.state.observedAtMs === null) return { kind: 'ignored' };
  if (
    previousSha !== undefined &&
    (head === undefined || !isCommitRevision(previousSha) || previousSha === head.sha)
  ) {
    return { kind: 'ignored' };
  }
  return {
    kind: 'actionable',
    trigger: 'pr_updated',
    requestNumber,
    ...(head === undefined ? {} : { head }),
    request,
    taskKeys: [],
    closingTaskKeys: [],
  };
}

function readTaskReferences(
  automation: GitAutomation,
  sources: readonly TaskReferenceSource[],
): VerifiedGitDelivery {
  const taskKeys = new Set<string>();
  const closingTaskKeys = new Set<string>();
  const linkSources: Record<string, GitLinkSource> = {};
  for (const [label, source] of sources) {
    if (typeof source !== 'string') continue;

    for (const [, verb, reference] of source.matchAll(TASK_REFERENCE)) {
      if (reference === undefined) continue;

      const key = reference.toUpperCase();
      taskKeys.add(key);
      linkSources[key] ??= label;
      if (taskKeys.size > MAX_TASK_KEYS) {
        return automation.trigger === 'pr_merged'
          ? { kind: 'actionable', ...automation, taskKeys: [], closingTaskKeys: [] }
          : { kind: 'ignored' };
      }

      if (automation.trigger === 'pr_merged' && verb && CLOSING_VERBS.has(verb.toLowerCase())) {
        closingTaskKeys.add(key);
      }
    }
  }

  if (
    taskKeys.size === 0 &&
    automation.trigger !== 'pr_closed' &&
    automation.trigger !== 'pr_merged' &&
    automation.trigger !== 'pr_reopened'
  ) {
    return { kind: 'ignored' };
  }

  return {
    kind: 'actionable',
    ...automation,
    taskKeys: [...taskKeys],
    closingTaskKeys: [...closingTaskKeys],
    ...(taskKeys.size === 0 ? {} : { linkSources }),
  };
}

function githubRepository(value: unknown): GitLinkMembers['repository'] {
  const repository = asObject(value);
  const fullName = nonEmpty(repository?.full_name);
  const url = webUrl(repository?.html_url);
  return fullName === undefined || url === undefined ? undefined : { fullName, url };
}

function gitlabRepository(value: unknown): GitLinkMembers['repository'] {
  const project = asObject(value);
  const fullName = nonEmpty(project?.path_with_namespace);
  const url = webUrl(project?.web_url);
  return fullName === undefined || url === undefined ? undefined : { fullName, url };
}

function githubAuthor(value: unknown): GitLinkMembers['author'] {
  const user = asObject(value);
  return providerAuthor(user?.login, user?.name);
}

function providerAuthor(login: unknown, name: unknown): GitLinkMembers['author'] {
  const account = nonEmpty(login);
  if (account === undefined) return undefined;
  const displayName = nonEmpty(name);
  return displayName === undefined ? { login: account } : { login: account, name: displayName };
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:' ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length !== 0 ? value : undefined;
}

function lineCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Drops the members a payload did not carry so they stay as recorded. */
function compact(members: {
  readonly [K in keyof GitLinkMembers]: GitLinkMembers[K] | undefined;
}): GitLinkMembers {
  const carried: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(members) as [string, unknown][]) {
    if (value !== undefined) carried[name] = value;
  }
  return carried;
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
