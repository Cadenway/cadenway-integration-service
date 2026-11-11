# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

The tables and rules on this page are **target domain behavior**, not proof of a running service or an approved API. Source: `wp-integration-domain` ([Claude](../.claude/skills/wp-integration-domain/SKILL.md), [Codex](../.codex/skills/wp-integration-domain/SKILL.md)). The linked mockup and guides remain the source for product details; confirm ambiguous values before implementation.

## What this service owns

GitHub and GitLab.

**Data**: GitHub App installations and GitLab group tokens, repositories mapped to spaces, Git accounts mapped to members, task Git links, Git automations per space, detection settings, webhook delivery log.

**API**: Connections, repositories, accounts, a task's links (link, unlink, create a branch), Git automations, redeliver a webhook, test event.

**Events emitted**: `git.branch-created`, `git.pr-opened`, `git.pr-merged`, `git.pr-closed`, `git.checks-completed`.

**Events consumed**: `task.purged` (removes links).

**External systems**: GitHub and GitLab APIs; their webhooks arrive through the API gateway's public routes.

**Mockup screens**: Development panel of the task detail, PR chips on rows and cards, Organisation › Intégrations, Git automations.

## Rules this service guards

- A branch, commit or PR citing a task id (WAY-482) is linked; `fixes`, `closes`, `resolves` close the task on merge.
- Default Git automations: branch created → progress, PR opened → review, PR merged → done; each can be "do nothing".
- A Git automation never moves a task backwards and never touches milestones; it calls task-service with the source `git`.
- Webhook signatures are verified before anything else.

## Notes

Arrives right after the first version.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). If the mockup disagrees with this guide, update the guide and its source skill for both assistants.

## Contract and delivery sequence

The `waypoint-api-contracts` repository owns HTTP and event specifications. Consumers use published `@waypoint/contracts` packages and `@waypoint/nest-messaging`; do not redefine payloads or connect to another service's database. Change contracts first, then the producing service, followed by gateways and listeners, and finally the webapp. Planned event names on this page must be checked against the actual published specification before use.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
