# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

The checkout contains NestJS startup, health and configuration code. Business modules will follow the structure below as their capabilities are implemented.

## Purpose and target structure

cadenway-integration-service owns GitHub and GitLab. NestJS, its own PostgreSQL database (one database and one user in the shared PostgreSQL of the VPS), events over NATS JetStream through `@cadenway/nest-messaging`, internal REST for the API gateway. Local port 3018.

|            |                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data       | GitHub App installations and GitLab group tokens, repositories mapped to spaces, Git accounts mapped to members, task Git links, Git automations per space, detection settings, webhook delivery log. |
| API        | Connections, repositories, accounts, a task's links (link, unlink, create a branch), Git automations, redeliver a webhook, test event.                                                                |
| Emits      | `git.branch-created`, `git.pr-opened`, `git.pr-merged`, `git.pr-closed`, `git.checks-completed`                                                                                                       |
| Listens to | `task.purged` (removes links)                                                                                                                                                                         |
| External   | GitHub and GitLab APIs; their webhooks arrive through the API gateway's public routes.                                                                                                                |
| Phase      | Right after the first version                                                                                                                                                                         |

Arrives right after the first version.

## Architectural ownership

Follow the [Cadenway NestJS architecture reference](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md) for module structure, dependency direction, naming and test placement.

- Business code lives in modules under `src/modules/<module>/`, each with `domain/`, `application/`, `infrastructure/`, `api/` and a `MODULE.md`.
- Cross-cutting plumbing (config, logging, tracing, errors, auth guards, messaging) comes from the cadenway-service-kit packages (`@cadenway/nest-common`, `@cadenway/nest-messaging`, `@cadenway/nest-testing`), never re-implemented here.
- The domain is pure; use cases own transactions; controllers and handlers translate.
- Rendering of anything user-facing belongs to the webapp; this service returns data and stable error codes.

## Boundaries

- No access to another service's database or internal code; cross-service needs use `@cadenway/contracts` routes or events.
- NATS only through `@cadenway/nest-messaging`; config, logs, errors, health and auth guards through `@cadenway/nest-common`.
- Routes and event payloads come from the installed `@cadenway/contracts`; never redefine them locally.
- The service is internal: no Traefik label, no public route; the API gateway is its only HTTP caller.
- No sibling sources imported, no `file:` or `link:` dependency on a sibling.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.
