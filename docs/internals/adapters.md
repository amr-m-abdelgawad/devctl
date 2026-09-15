# Adapters

`app/src/adapters/` is I/O. Adapters may import ports, domain, shared, and other adapters. They must not import `presentation/` or `application/` (bootstrap injects commands).

This page is a catalog of **every adapter package**. Read the named files; do not treat `Supervisor` as the only place behavior lives.

## `adapters/daemon/` — supervisor host

The daemon is split so `supervisor.ts` coordinates rather than implementing every subsystem inline.

| File | Role |
|------|------|
| `supervisor.ts` | Lock, `run()`, `dispatch()`, runtime maps, `lifecycleSession()`, persist, bind orchestrator |
| `daemon.ts` | `resolveDaemonTarget` / state-dir scan (client-side helper living next to daemon concepts) |
| `recover.ts` | Adopt PIDs/containers from `state.json` |
| `reload.ts` | Config + plugin reload, `watchConfig`, `diffReload`, registry apply |
| `service-watch.ts` | Per-service file watchers → restart |
| `environment-bridge.ts` | Builds `EnvRequest` (ports, proxy URL, token endpoint, OTLP, recipes) for `resolveEnvironment` |
| `identity-coordinator.ts` | Identity cache, credential list, SA probes, `refreshIdentity` |
| `proxy-coordinator.ts` | HTTP/gRPC proxy + token endpoint bind; suppression flag |
| `mcp-coordinator.ts` | MCP listen, token rotate, deny-list persistence |
| `web-coordinator.ts` | Loopback web UI listen |
| `telemetry-coordinator.ts` | Optional OTLP HTTP receiver |
| `resource-sampler.ts` | Host CPU/memory samples for Stats |
| `snapshot.ts` | `StatusSnapshot` assembly + `formatStatusFromSnapshot` |

`Supervisor` still owns persistence, adoption orchestration, and the facades (`asMcpHost()`). Public `start`/`stop`/`restart` delegate to the orchestrator.

## `adapters/rpc/`

| File | Role |
|------|------|
| `server.ts` | Listen, auth, dispatch, event subscribe, write queue |
| `controller.ts` | Dial, spawn `_supervisor`, `Controller`, handshake |
| `params.ts` | Loose JSON → domain filters/arrays |

See [RPC](rpc.md).

## `adapters/config/`

See [config pipeline](config-pipeline.md). Entry barrel: `index.ts` (re-exports domain config types for adapter convenience — presentation must still not import this barrel).

## `adapters/process/`

| File | Role |
|------|------|
| `processes.ts` | `ProcessManager implements ProcessRuntime`; spawn via `Bun.spawn`; adopt; `runOnce`; delegates containers |
| `unix.ts` | Process inspect, tree kill, `vm_stat` samples, command matching |
| `windows.ts` | Same for Windows (WMIC/CIM, named-pipe world) |

Host processes are `detached` on Unix so they survive the client. Graceful stop: SIGTERM then SIGKILL after `graceMs`.

## `adapters/containers/`

Docker/Podman: `startContainer`, `adoptContainer`, port publishes, env (no full `process` layer), limits from `domain/service/container-limits.ts`. Integration tests gated on `DEVCTL_CONTAINER_TESTS=1`.

## `adapters/environment/`

`resolveEnvironment`, `ENV_SOURCE_ORDER`, dotenv family, keychain/secret-manager fetch, `${}` resolution via `config/refs.ts`. Plugin `EnvironmentSource` spliced before `defaults`. Documented for users in `docs/environment.md`; this adapter is the implementation.

## `adapters/health/`

Built-in checkers: `http`, `tcp`, `process`, `command`. `healthCheckerFactory(plugins)` looks up type. Unknown types fail validation after plugins load.

## `adapters/google/`

| File | Role |
|------|------|
| `google.ts` | `detectGoogle`, `loginGoogle`, `logoutGoogle` (gcloud / ADC) |
| `token.ts` | `TokenManager`: cache, single-flight refresh, user / SA impersonation / IAP providers |
| `secret-manager.ts` | REST fetch for `projects/.../secrets/...` |
| `gcp-env.ts` | Imported first from `bin.ts` to tame metadata server lookups |
| `testdata/mock-iap-server.ts` | Tests |

`TokenManager` must not mint SA private keys. Concurrent refreshes share a per-(identity, audience, scopes) lock.

## `adapters/http/`

`RecipeRuntime`: fetch named recipes, JWT/TTL cache, optional loopback expose via proxy. `identity.ts` maps recipe auth onto `TokenManager`.

## `adapters/proxy/`

| File | Role |
|------|------|
| `proxy.ts` | HTTP reverse proxy, route match, token inject, CORS preflight, request ring, `X-Devctl-Request-ID`, optional LLM body-capture tee (via `LlmCaptureSink`) |
| `grpc-proxy.ts` | h2c loopback → h2+TLS upstream with the same auth |
| `tracing.ts` | Span creation around proxy hops |
| `security.test.ts` | Loopback and header guarantees |

Token endpoint (`GET /token`) is loopback + internal token (`DEVCTL_INTERNAL_TOKEN`). Never log `Authorization`.

## `adapters/storage/`

| File | Role |
|------|------|
| `storage.ts` | `homeDir`, session dir, lock, socket, rpc-token, MCP token, `state.json`, bootstrap logs |
| `logs.ts` | `LogManager` ring, persist, export, parsers |
| `worker-log-store.ts` | Worker thread wrapper (`log-worker.ts` + protocol) so ingest does not block the daemon |
| `spans.ts` | In-memory span forest |
| `credentials.ts` | OS keychain with file fallback `0600` |

## `adapters/llm/`

`LlmCoordinator` polls **pull** sources; `litellm.ts` / `litellm-map.ts` map spend logs. The **push** `proxy` driver (`proxy-driver.ts`) is fed out-of-band by `proxy-capture.ts` (the `LlmCaptureSink` the HTTP proxy calls) + `proxy-capture-map.ts` (JSON/SSE bodies → ingest). `store.ts` is the ring; `factory.ts` registers drivers including plugins.

## `adapters/telemetry/`

`otlp-http.ts` — optional loopback OTLP HTTP receiver feeding `LogStore` / `SpanStore`.

## `adapters/secrets/`

`Detector` — name markers + regexes; extra lists from config. Shared redaction helpers also live in `shared/redaction.ts` for presentation.

## `adapters/net/`

Port allocation (`assignPorts`, `freePort`), MCP default port helper.

## `adapters/plugins/`

`registry.ts` loads `plugins[].path` (Bun file plugins). Extension points: health, identity/token, environment sources, log parsers, proxy middleware, LLM sources. `PLUGIN_SDK_VERSION`. Failures skip that plugin and log; unknown *configured* types after load are validation errors.

Public import path for plugin authors: `app/src/plugin-sdk.ts`.

## `adapters/doctor/`

Implements `DoctorRunner`. Checks: tools, ports, containers, ADC, impersonation, APIs. Never auto-enables cloud APIs.

## `adapters/update/`

GitHub releases for `devctl update`.

## `adapters/system/`

`clock.ts`, `filesystem.ts`, `host-stats.ts` (CPU/mem for the sampler).

## Rule of thumb

If a file talks to the OS, Google, Docker, or the network, it is an adapter. If it decides *whether* a transition is legal, it is domain. If it sequences a start wave, it is application.
