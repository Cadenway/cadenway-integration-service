# Git webhooks

## Purpose

Authenticates original GitHub and GitLab webhook bytes, admits bounded work for the registered
repository and dispatches each referenced task through Task's internal Git command.

## Public entry points

API Gateway exposes the provider-facing endpoints. Signed system calls to Integration carry no
organization. The receiver registration supplies the authoritative tenant.

## Owned tables

- `git_webhook_receivers` stores provider, tenant, current signing revision and enablement.
- `git_repository_mappings` binds an authenticated provider repository and installation to a space,
  integration identity and mapping author.
- `git_webhook_deliveries` and `git_webhook_delivery_ids` store receipt digests and provider aliases.
- `git_dispatch_claims` reserves one stable Task command key per admitted target and records its
  terminal disposition. The jobs runtime owns the queue tables.
- `git_links` stores versioned changes per verified provider reference and authorized task.
- `git_purged_tasks` stores the terminal task key fence used by replay and cleanup.

## API

- `POST /internal/v1/webhooks/github?bindingId=<uuid>`
- `POST /internal/v1/webhooks/gitlab?bindingId=<uuid>`

Both routes return a private 204 after admission commits and use a uniform provider authentication
refusal. An empty receiver configuration keeps inbound Git dispatch disabled. Each configured
receiver has a deployment-supplied signing credential and a matching enabled database registration.

## Events emitted

- `git.branch-created.v1`
- `git.pr-opened.v1`
- `git.pr-merged.v1`
- `git.pr-closed.v1`
- `git.checks-completed.v1`

Each fact carries the canonical task key, authorized placement and stable link ID and version. The
provider content stays in Integration.

## Events consumed

`task.purged.v1`. The `purge-task-git-links` durable fences the canonical task key and removes its
links in batches of at most 500. The consumer and continuation worker are enabled together with
link creation by `GIT_LINK_EVENTS_ENABLED`. Both stay off until the broker grants the durable
consumer and Task exposes its signed Git command. Set `GIT_LINK_PURGE_ENABLED` before first link
activation and keep it enabled when new link admission pauses so existing links keep receiving
terminal task purges.

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
- Up to 20 distinct task references are read from one delivery. Branch creation proposes `progress`,
  opening a pull request proposes `review`, and a merged pull request proposes `done` for keys with
  a closing verb in the signed merge delivery. The merge also settles authorized existing links
  for the same request, including links whose task references were removed or exceeded the limit.
  An inferred task can only update an existing link. A signed closure, current request-head
  observation or completed check can only use an existing link for the same receiver,
  verified provider binding and request number. A check must match the current observed
  head and advance its check watermark. Conflicting heads at the same provider timestamp are ignored
  because their delivery order cannot establish which one is current. These deliveries do not change
  Task status.
  Task owns current
  visibility, the mapping author's authority, status progression and activity.
- The worker uses the same Task command ID across transport attempts. It sends no action after the
  one-hour command window. Exhausted attempts go to a dead-letter queue with fixed diagnostics.

## Transactions

- Admission locks the receiver, revalidates its revision and checks for duplicates before resolving
  the exact repository mapping under the tenant transaction. A fresh receipt, its delivery ID and
  all of its target jobs commit together.
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
- Link-producing receipts go to `integration.dispatch-git-link` and preserve that choice until
  settlement. Compatibility workers continue to handle the original status queue. A compatible
  worker can drain the link queue after new link admissions are disabled.
- Dispatch reserves its Task command ID in a short tenant transaction, performs HTTP outside the
  transaction and revalidates the receiver and mapping when recording Task's authorized placement.
- A replayed Task receipt obtains current signed placement through a fresh no-op command. The
  dispatch settlement, changed link and corresponding fact commit together.
- Purge uses the same tenant and task key lock as link creation. The event receipt, marker,
  deletion batch and any continuation commit together. The marker blocks recreation between
  batches.

## Decisions

- GitHub delivery verification follows the
  [GitHub webhook documentation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- GitLab delivery verification follows
  [GitLab signing tokens](https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens).
  GitLab's legacy token header carries a plaintext token and has no role in this verifier.
