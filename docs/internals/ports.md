# Ports

Ports are TypeScript types (and tiny aliases) under `app/src/ports/`. They are the **only** place application code names an infrastructure capability.

## Catalog

| Port | File | Implemented by | Why it exists |
|------|------|----------------|---------------|
| `Clock` | `clock.ts` | `adapters/system/clock.ts` | Deterministic tests; ISO timestamps |
| `FileSystem` | `filesystem.ts` | `adapters/system/filesystem.ts` | Tiny exists/read/write used by supervisor |
| `ProcessRuntime` | `process-runtime.ts` | `ProcessManager` | Spawn, stop, `runOnce`, containers |
| `HealthChecker` / `HealthCheckerFactory` | `health-checker.ts` | `adapters/health/health.ts` + plugins | HTTP/TCP/process/command/gRPC (+ custom types) |
| `LogStore` | `log-store.ts` | `worker-log-store.ts` / in-process `LogManager` | Ring + persist + page + redact |
| `SpanStore` | `span-store.ts` | `adapters/storage/spans.ts` | Trace trees |
| `LlmCallStore` | `llm-call-store.ts` | `adapters/llm/store.ts` | Inspector ring |
| `LlmSource` / factory | `llm-source.ts` | `adapters/llm/factory.ts`, LiteLLM + proxy drivers, plugins | Pull (spend logs) or push (proxy capture) sources |
| `LlmCaptureSink` | `llm-capture.ts` | `adapters/llm/proxy-capture.ts` | Proxy tees completion bodies into the LLM store without importing the llm package |
| `TrafficCallStore` | `traffic-call-store.ts` | `adapters/traffic/store.ts` | Traffic inspector ring |
| `TrafficCaptureSink` | `traffic-capture.ts` | `adapters/traffic/capture.ts` | HTTP/gRPC proxies tee bodies into the traffic store without importing the traffic package |
| `HttpRecipeRuntime` | `http-recipe-runtime.ts` | `adapters/http/runtime.ts` | Named outbound fetches + cache |
| `DoctorRunner` | `doctor-runner.ts` | `adapters/doctor/doctor.ts` | Diagnostics without adapter types in application |
| `McpHost` / `McpListener` / factory | `mcp-host.ts` | Supervisor facade + `McpHttpServer` | MCP tools call this, not `Supervisor` |
| `WebListener` / factory | `web-host.ts` | `WebHttpServer` | Same host API, HTML/JSON |
| `Update` | `update.ts` | `adapters/update/update.ts` | GitHub release check/apply |
| `CredentialProvider` | `credential-provider.ts` | *(reserved)* | Future token-provider split; unused; Knip-ignored |
| `DaemonCommandHost` / `DaemonCommands` | `daemon-commands.ts` | Supervisor + `commandsForHost` | RPC/commands without importing application from adapters |
| `ServiceOrchestratorPort` / `HealthController` | `orchestrator.ts` | `ServiceOrchestrator` / `HealthMonitor` | Supervisor holds a port, not a concrete import of application internals beyond bind |
| `LifecycleSession` / `HealthHost` | `lifecycle-session.ts` | Supervisor object literal | Orchestrator callbacks into daemon-owned state |

`ports/daemon.ts` re-exports orchestrator + command host types for a single import path.

## `ProcessRuntime` contract

```ts
start(spec) / startContainer(spec) / stop(name, graceMs)
runOnce(spec)          // tasks, hooks, exec, doctor commands
isRunning / get / all
```

`ProcessSpec` includes `shell`, `graceMs`, line and exit callbacks. Containers have image, volumes, limits, mapped ports.

## `LifecycleSession`

The orchestrator’s view of the daemon. Notable fields:

- `runtimes`, `ports`, `clientEnv`, `processMeta`, `serviceProfile`
- `prepareServiceIdentity`, `resolveServiceExecution`, `ensureHttpRecipes`
- `claimIfAlreadyUp`, `assignPendingPorts`, `releasePorts`, `forgetService`
- `detectGoogle`, `startProxy`, `proxySuppressed`
- `setState`, `persistState`, `fail`, `log`

When you need a new capability during `startOne`, add it here (and on the supervisor’s `lifecycleSession()` object). Do not pass `Supervisor` into the orchestrator.

## `McpHost`

Subset of daemon operations MCP and the web UI share: status, logs page, LLM, traffic, config, validate text, start/stop/restart, reload, doctor, exec, tasks, proxy, traces. `config()` for MCP is a **redacted** summary via tools; full `config_snapshot` stays RPC-only.

## Do not add

- `IOrchestratorService` wrapping `ServiceOrchestrator` — the class already implements a port.
- Ports for every adapter function. `TokenManager` is still a concrete class injected at bootstrap; Google stays behind that class and `detectGoogle` function types on the supervisor deps.
