# Git webhooks

## Purpose

Authenticates original GitHub and GitLab webhook bytes, admits bounded work for the registered
repository, dispatches each referenced task through Task's internal Git command, projects the
task Git links of the Development panel and serves their read to the API gateway.

## Public entry points

API Gateway exposes the provider-facing endpoints. Signed system calls to Integration carry no
organization. The receiver registration supplies the authoritative tenant.

The Integration image provides the operator-only `node dist/main.js git-binding` command to
register a binding and repository mapping, rotate its active signing revision or revoke the
binding. See the [operator commands](../../../docs/development.md#git-binding-operations).

## Owned tables

- `git_webhook_receivers` stores provider, tenant, current signing revision and enablement.
- `git_repository_mappings` binds an authenticated provider repository and installation to a space,
  integration identity and mapping author.
- `git_webhook_deliveries` and `git_webhook_delivery_ids` store receipt digests and provider aliases.
- `git_dispatch_claims` reserves one stable Task command key per admitted target and records its
  terminal disposition. The jobs runtime owns the queue tables.
- `git_links` stores the versioned `GitLink` projection per verified provider reference and
  authorized task, with a provider-time watermark for the lifecycle and for each other member, and
  the internal `reconciliation pending` mark.
- `git_check_observations` stores the latest state of each check suite or merge request pipeline
  per organization, receiver repository and head SHA, independent of links.
- `git_merge_intents` stores the single merge intent of a link, `pending` or `handled`, with the
  creating delivery, its Task command key, attempts and the Task disposition or refusal reason.
- `git_purged_tasks` stores the terminal task key fence used by replay and cleanup.

## API

- `POST /internal/v1/webhooks/github?bindingId=<uuid>`
- `POST /internal/v1/webhooks/gitlab?bindingId=<uuid>`
- `GET /internal/v1/tasks/{taskKey}/git-links` (`listTaskGitLinksInternal`)

Both routes return a private 204 after admission commits and use a uniform provider authentication
refusal. An empty receiver configuration keeps inbound Git dispatch disabled. Each configured
receiver has a deployment-supplied signing credential and a matching enabled database registration.

The link read accepts only a `user` actor of `api-gateway` with an organization; the gateway asks
Task for read access first. It is bounded by that organization and the task key, pages newest
first by `(createdAt, id)` with a cursor bound to both, and answers `integration.unavailable` when
the links cannot be read.

## Events emitted

- `git.branch-created.v1`
- `git.pr-opened.v1`
- `git.pr-merged.v1`
- `git.pr-closed.v1`
- `git.pr-reopened.v1`
- `git.checks-completed.v1`
- `git.link-updated.v1`

Each fact carries the canonical task key, authorized placement and stable link ID and version. The
provider content stays in Integration. Every committed projection change takes the next link
version and one fact; a creation that finds stored check observations publishes its opening fact,
then `git.link-updated.v1` naming `checks`.

## Events consumed

`task.purged.v1`. The `purge-task-git-links` durable fences the canonical task key and removes its
links in batches of at most 500. The consumer and continuation worker are enabled together with
link creation by `GIT_LINK_EVENTS_ENABLED`. Both stay off until the broker grants the durable
consumer and Task exposes its signed Git command. Set `GIT_LINK_PURGE_ENABLED` before first link
activation and keep it enabled when new link admission pauses so existing links keep receiving
terminal task purges.

Rollout: Keep `GIT_LINK_EVENTS_ENABLED` off during any deployment where this release and an earlier
one both run, during the GitOps agent's rolling replacement as during a rollback: a worker of an
earlier release can settle a newer head on a link and leave the previous head's checks on it. Turn
it on only once no earlier replica runs. To roll back, turn it off first, drain the link queues,
then roll back.

## Invariants

- Configure a signing key dedicated to each receiver. Verify the original body before decoding JSON.
  Startup requires distinct secrets across receivers. The dedicated token identifies the GitLab
  instance for the receiver because its numeric project IDs are local to that instance.
- The HTTP parser and the verifier reject bodies larger than 1,048,576 bytes.
- GitHub authenticates only the body. Its delivery ID and event name are untrusted routing metadata.
  The receiver binding determines the Cadenway organization. Authenticated provider identifiers
  must match the installation and repository recorded in that binding. Intake must fence GitHub
  replays by atomically recording the body digest scoped to the receiver. A replay with a different
  delivery ID creates neither an alias nor another action. The admitted delivery ID and historical
  aliases continue to fence reuse with a different digest.
- GitLab authenticates the delivery ID, original timestamp text and body. The timestamp must be
  within 300 seconds of the receiver clock. The event name is untrusted routing metadata.
- Each provider's signature is compared against the computed digest in constant time. GitLab
  signature lists may contain multiple versions or signatures for key rotation. Only a matching
  `v1` signature for the configured `whsec_` key authenticates the payload.
- Up to 20 distinct task references are read from one delivery. Branch creation proposes `progress`
  and opening a pull request proposes `review`. A merged pull request proposes `done` for keys with
  a closing verb in the signed merge delivery, through the link's merge intent. The merge also
  settles authorized existing links for the same request, including links whose task references
  were removed or exceeded the limit. An inferred task can only update an existing link. A closure,
  reopen, member update (GitHub `edited`, `ready_for_review`, `converted_to_draft`,
  `review_requested`, `review_request_removed`, `synchronize`; GitLab `update`), head
  observation or check can only use an existing link for the same receiver, verified provider
  binding and request number. These deliveries do not change Task status. Task owns current
  visibility, the mapping author's authority, status progression and activity.
- The lifecycle and every other projected member keep their own provider-time watermark with the
  admission sequence of its delivery, drawn under the receiver lock: an older delivery is ignored
  for that member, and an equal one is applied in admission order even when a later admission
  settles first. `merged` is final and a verified merge action supersedes `closed` whatever its
  time, while a snapshot reporting `merged` follows the watermark. A lifecycle fact covers the
  other members of its delivery, but a head or checks change also publishes `git.link-updated.v1`. Any request action,
  and a GitLab merge request pipeline, realigns the lifecycle from the reported state when it is not
  older, without a head or Task status when the action is not a lifecycle or head change. An
  equal-time delivery whose lifecycle differs marks the link `reconciliation pending`, and a
  strictly newer one carrying the state clears it. There is no provider client before gap B5: the
  hourly maintenance reports each mark once, `merged` links aside.
- Check observations are stored at admission per repository, head SHA and suite or pipeline, in
  one conditional upsert under their own provider-time watermark, whether or not a link exists. A
  running GitLab pipeline is ordered by its latest job time, so a retry replaces its completion. The
  aggregate is computed in SQL over every observation of the current head: `stale` GitHub suites
  are left out, the GitLab pipeline with the highest ID counts, and it is absent with no eligible
  observation. It is recomputed on creation, on a head change and on a check of the current head.
  Each observation refreshes every existing link whose current head is its head, in resumable
  pages of 20 links queued on `integration.refresh-git-head-checks`, each recorded as a receipt of
  its own, the links of the request the delivery names included; the check receipt itself admits
  no work. A GitLab merge request pipeline also pages through every link of its merge request,
  whatever their head, to realign the lifecycle from the state it reports.
  A check receipt of the previous release, without observation, only advances the completion
  time, which the read returns as `checksCompletedAt` while `checks` stays absent. An observation whose head is no current
  head of a link of its receiver and repository is pruned 7 days after its last update by the
  hourly `integration.git-link-maintenance` job.
- The first verified merge delivery of a link records its merge intent in the dispatch settlement
  transaction, under the link lock, whatever the lifecycle shows. Its command key is the dispatch
  claim ID; the merge dispatch of a link-recording receipt authorizes the link under that key with
  a `:link` suffix and no status. A status-only receipt, and one admitted by the previous release,
  still sends `done` with its dispatch under the claim ID; the previous-release receipt records its
  intent `handled` with that disposition. A later merge delivery finds the intent and submits
  nothing. The `integration.submit-git-merge-intent` job submits `done`, retries a failure or
  ambiguous answer with backoff from one minute to one hour under the same key, and stops resending
  once the next attempt would fall outside 24 hours of the earlier of the claim and the intent: the
  intent then stays `pending` and the maintenance reports it once. The maintenance also re-enqueues
  an in-window pending intent untouched for two hours, whose job the queue exhausted, under a
  recovery occurrence it records on the intent and the same command key. Task's
  `applied` or `no_op` marks it `handled`; `task.not-found`, `task.trashed`, a reused key or an
  invalid request marks it `handled` with that reason. The intent and maintenance workers run
  whatever the link flags, as the link dispatch worker does.
- The worker uses the same Task command ID across transport attempts. It sends no action after the
  one-hour command window. Exhausted attempts go to a dead-letter queue with fixed diagnostics.

## Transactions

- Admission locks the receiver, revalidates its revision and checks for duplicates before resolving
  the exact repository mapping under the tenant transaction. A fresh receipt, its delivery ID and
  all of its target jobs commit together.
- Operator changes use the same receiver row lock. Registration and its first mapping commit
  together, an identical mapping is safe to repeat, and revocation permanently disables the
  binding ID. Rotation blocks admission and preparation at the previous revision. A Task request
  whose preparation already committed can still complete after rotation or revocation, while
  Integration rejects its obsolete settlement.
- The receiver selects at most 20 tasks from existing links and prior accepted work for the same
  request. A merge combines that audience with up to 20 distinct signed task references. If pending
  work would exceed the historical limit, the merge keeps the bounded set of recorded links.
  If an earlier opening or head observation still needs to settle, the dependent job keeps
  its prerequisites and retries inside its dispatch window. A job without an approved Task
  placement does not create a link.
- A blocked check for a live predecessor records a delayed job with the same receipt and target
  before completing the current job. Its polling slot follows the PostgreSQL clock and has a
  stable occurrence key within the check's original dispatch window. An expired predecessor with an
  unsettled verified head observation closes the dependent check without a Task command or check event.
  Checks that resume still compare the exact current recorded head under the link lock.
- Link-producing receipts go to `integration.dispatch-git-link.v2`, which only workers that know
  merge intents and the newer request and check facts consume, and preserve that choice until
  settlement. Current workers also drain `integration.dispatch-git-link`, where receipts of the
  previous release wait, and compatibility workers continue to handle the original status queue.
  Before rolling back to the previous release, drain the v2 queue: only the current image
  consumes it.
- Dispatch reserves its Task command ID in a short tenant transaction, performs HTTP outside the
  transaction and revalidates the receiver and mapping when recording Task's authorized placement.
- A replayed Task receipt obtains current signed placement through a fresh no-op command. The
  dispatch settlement, changed link, its facts, a new merge intent and its first job commit
  together.
- A merge intent attempt is claimed and settled in two short transactions that lock the intent row;
  the Task call stays outside them. The next attempt's job commits with the failed settlement.
- Purge uses the same tenant and task key lock as link creation. The event receipt, marker,
  deletion batch and any continuation commit together. The marker blocks recreation between
  batches.

## Decisions

- GitHub delivery verification follows the
  [GitHub webhook documentation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- GitLab delivery verification follows
  [GitLab signing tokens](https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens).
  GitLab's legacy token header carries a plaintext token and has no role in this verifier.
