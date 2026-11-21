# Git webhooks

## Purpose

Authenticates incoming GitHub and GitLab webhook payloads using the key configured for the receiver.
The verification adapter takes the original request bytes and returns their SHA-256 digest on
success. Exactly the bytes provided by the caller are used for both the signature and the digest.

## Public entry points

None. The verifier is internal to this capability.

## Owned tables

None.

## API

The composition root has no registered routes. HTTP wiring and the receiver lookup belong to the
delivery intake that calls this adapter.

## Events emitted

None.

## Events consumed

None.

## Invariants

- Configure a signing key dedicated to each receiver. Verify the original body before decoding JSON.
- Reject bodies larger than 1,048,576 bytes. HTTP intake also applies this limit while reading the
  body.
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

## Transactions

None. Durable delivery acceptance, deduplication and replay fencing belong to the caller's intake
transaction.

## Decisions

- GitHub delivery verification follows the
  [GitHub webhook documentation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- GitLab delivery verification follows
  [GitLab signing tokens](https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens).
  GitLab's legacy token header carries a plaintext token and has no role in this verifier.
