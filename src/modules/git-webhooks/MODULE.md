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

Each fact carries the canonical task key, authorized placement and stable link ID and version. The
provider content stays in Integration.

## Events consumed

`task.purged.v1`. The `purge-task-git-links` durable fences the canonical task key and removes its
links in batches of at most 500. The consumer and continuation worker are enabled together with
link creation by `GIT_LINK_EVENTS_ENABLED`. It defaults to off until the broker grants the durable
consumer and Task exposes its signed Git command.

## Invariants

- Configure a signing key dedicated to each receiver. Verify the original body before decoding JSON.
- The HTTP parser and the verifier reject bodies larger than 1,048,576 bytes.
- GitHub authenticates only the body. Its delivery ID and event name are untrusted routing metadata.
  The receiver binding determines the Cadenway organization. Authenticated provider identifiers
  must match the installation and repository recorded in that binding. Intake must fence GitHub
  replays by atomically recording the body digest scoped to the receiver. An original body presented
  with a different delivery ID cannot trigger another action.
- GitLab authenticates the delivery ID, original timestamp text and body. The timestamp must be
  within 300 seconds of the receiver clock. The event name is untrusted routing metadata.
- Each provider's signature is compared against the computed digest in constant time. GitLab
  signature lists may contain multiple versions or signatures for key rotation. Only a matching
  `v1` signature for the configured `whsec_` key authenticates the payload.
- Up to 20 distinct task references are admitted together. Branch creation proposes `progress`,
  opening a pull request proposes `review`, and a merged pull request proposes `done` for keys with
  a closing verb. Other merge references and closing a request only resolve authorized placement.
  Task owns current
  visibility, the mapping author's authority, status progression and activity.
- The worker uses the same Task command ID across its five attempts. It sends no action after the
  one-hour command window. Exhausted attempts go to a dead-letter queue with fixed diagnostics.

## Transactions

- Admission locks the receiver, revalidates its revision and resolves the exact repository mapping
  under the tenant transaction. A fresh receipt, its alias and all of its target jobs commit
  together. An exact replay does not create any job.
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
