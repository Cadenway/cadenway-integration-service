---
name: wp-integration-domain
description: "The data, rules, events and screens waypoint-integration-service owns, taken from the mockup, the integration guide and the repositories document. Load it before naming, modeling or testing anything in this service."
---

# integration-service domain

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
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). When the mockup and this skill disagree, the mockup wins and
this skill is corrected in the same change.
