# Roadmap

What devctl works on before v1.0, in order. Each item is a GitHub issue, so the issue is where the details and the discussion live. [Platform bets](platform-bets.md) are separate products that wait until Phases 1–3 are in daily use.

Sizes are relative: **S** is a contained change in one or two modules, **M** a new piece of a subsystem, **L** cross-cutting design work.

## Phase 1: fix what the documented paths get wrong

Bugs on paths the docs promise, and the process that keeps them from coming back.

| Item | Issue | Size | Status |
|------|-------|------|--------|
| Proxy isolation between checkouts | [CHANGELOG 0.22.0](https://github.com/amr-m-abdelgawad/devctl/blob/main/CHANGELOG.md#0220---2026-09-26) | S | Done in 0.22.0 |
| `http` / `grpc` health checks can't target `ports: auto` | [#111](https://github.com/amr-m-abdelgawad/devctl/issues/111) | S | Done |
| Stock OpenTelemetry SDKs can't export to devctl (protobuf, gzip) | [#112](https://github.com/amr-m-abdelgawad/devctl/issues/112) | M | Done |
| The log parser drops the text around embedded JSON | [#113](https://github.com/amr-m-abdelgawad/devctl/issues/113) | S | Done |
| End-to-end tests of documented scenarios | [#114](https://github.com/amr-m-abdelgawad/devctl/issues/114) | M | Done; new scenarios land with each fix |
| Users outside the original stack; experimental labels; this roadmap | [#115](https://github.com/amr-m-abdelgawad/devctl/issues/115) | Ongoing | In progress |
| macOS in the unit-test CI job | [#116](https://github.com/amr-m-abdelgawad/devctl/issues/116) | S | Done |

## Phase 2: work the way agents and CI work

| Item | Issue | Size | Status |
|------|-------|------|--------|
| Parallel, isolated stacks per checkout or named instance | [#117](https://github.com/amr-m-abdelgawad/devctl/issues/117) | L | Shipped ([Parallel stacks](parallel-stacks.md)), experimental |
| Test/CI harness: `start --wait`, `devctl test`, a failure bundle | [#118](https://github.com/amr-m-abdelgawad/devctl/issues/118) | M | Shipped ([Tests and CI](ci.md)), experimental |
| Proxy replay, mocks and fault injection | [#119](https://github.com/amr-m-abdelgawad/devctl/issues/119) | M | Open |

## Phase 3: fill the gaps around the core

| Item | Issue | Size | Status |
|------|-------|------|--------|
| Containers as full citizens: builds, networks, host access, OTLP env | [#120](https://github.com/amr-m-abdelgawad/devctl/issues/120) | L | Open |
| Debug mode: run a service under a debugger, generate an attach config | [#121](https://github.com/amr-m-abdelgawad/devctl/issues/121) | M | Open |
| OTLP metrics and per-route charts | [#122](https://github.com/amr-m-abdelgawad/devctl/issues/122) | M | Open |
| Local HTTPS for proxy hostnames | [#123](https://github.com/amr-m-abdelgawad/devctl/issues/123) | M | Open |
| Opt-in public tunnels for webhooks | [#124](https://github.com/amr-m-abdelgawad/devctl/issues/124) | M | Open |
| Toolchain checks and setup | [#125](https://github.com/amr-m-abdelgawad/devctl/issues/125) | M | Open |
| Crash notifications | [#126](https://github.com/amr-m-abdelgawad/devctl/issues/126) | S | Open |
| `<service>.local` hosts setup | [#127](https://github.com/amr-m-abdelgawad/devctl/issues/127) | S | Open |

## Unscheduled: if users need them

These depend on who ends up using devctl. They move into a phase when someone outside the original stack asks for them.

| Item | Issue | Size |
|------|-------|------|
| Cloud auth and secrets beyond Google (AWS SigV4, SSO, Azure Entra) | [#128](https://github.com/amr-m-abdelgawad/devctl/issues/128) | L |
| Multi-repo workspaces | [#129](https://github.com/amr-m-abdelgawad/devctl/issues/129) | L |

## Experimental features

A feature is **experimental** until a user outside the original stack relies on it. Until then its configuration and behavior may change in a minor release, without a deprecation period. Each one is marked in its docs with the same line:

> **Experimental.** … may change without a deprecation period. See [Experimental features](#experimental-features).

| Feature | Since | Docs |
|---------|-------|------|
| `transform.request_body` on proxy routes | 0.20.0 | [Proxy](proxy.md#rewrite-the-request-body) |
| `auth.suppress_authorization` | 0.17.0 | [Proxy](proxy.md#extra-token-headers), [IAP](iap.md) |
| LLM `capture.field_map` and `cost_per_token` | 0.16.0 | [LLM inspector](llm.md#proxy-capture-source-type-proxy) |
| gRPC body decoding (`inspect.grpc`, `trafficDecoders`) | 0.16.0 | [Proxy](proxy.md#inspect-bodies) |
| `environment.sops` | 0.19.0 | [Environment](environment.md#sops) |
| `environment.terraform` | 0.22.0 | [Environment](environment.md#terraform) |
| `environment.helm` | unreleased | [Environment](environment.md#helm) |
| Parallel stacks: port slots, `--instance`, per-stack volumes, `devctl mcp --write` | 0.22.0 | [Parallel stacks](parallel-stacks.md) |
| `devctl test`, `devctl bundle`, `start --wait` | 0.22.0 | [Tests and CI](ci.md) |

When a feature graduates, its line comes out of the docs and the CHANGELOG says so under **Changed**, for example: "`environment.sops` is no longer experimental."

## Feedback from other stacks

Most of devctl so far was shaped by one stack (Temporal, IAP, Workspace OAuth, LiteLLM, uvicorn, Vite). The missing input is teams on other stacks: AWS, Node-only, Go, a polyrepo org. If you try devctl on yours, onboard with the [`devctl-onboard` skill](https://github.com/amr-m-abdelgawad/devctl/blob/main/skills/devctl-onboard/SKILL.md) and no other help. Wherever you get stuck, open a ["Doesn't fit my stack"](https://github.com/amr-m-abdelgawad/devctl/issues/new?template=doesnt-fit-my-stack.md) issue. Its blockers become issues here, and the reports are linked from [#115](https://github.com/amr-m-abdelgawad/devctl/issues/115).

## Toward v1.0

v1.0 is the point where the codebase has been personally reviewed, tested and validated (see [Project status](https://github.com/amr-m-abdelgawad/devctl#project-status)). To keep that reachable while features land:

- New surface starts experimental, as above.
- Phase 1 comes before new Phase 2 and 3 features.
- A feature freeze before 1.0 is likely, so review can catch up with what has shipped.

## Related

- [Platform bets](platform-bets.md)
- [Architecture](architecture.md)
- [CHANGELOG](https://github.com/amr-m-abdelgawad/devctl/blob/main/CHANGELOG.md)
