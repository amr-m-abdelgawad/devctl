# Domain

`app/src/domain/` is types, invariants, and pure functions. No filesystem, no sockets, no Google SDK, no OpenTUI. If a function needs I/O, it does not belong here.

Brand IDs (`domain/ids.ts`): `serviceId()`, `profileId()` wrap strings so start/profile APIs cannot mix raw names accidentally. RPC still uses strings at the wire; convert at the command boundary (`StartService`, `ResolveStart`).

## `domain/config/`

| File | Role |
|------|------|
| `types.ts` | `DevctlConfig` and every nested config type (`ServiceConfig`, `ProxyConfig`, `HttpRecipeConfig`, `LlmConfig`, …). Helpers: `emptyService`, `graceSeconds`, `stopOnExit`, `dependencyName`, HTTP key names. **This is the post-load snapshot.** |
| `paths.ts` | `ConfigDirName` (`.devctl`), `ConfigFileName` (`config.yaml`). |
| `env-ref.ts` | `${…}` reference parsing and `secretTemplateLabel`. |
| `snapshot.ts` | Diff two configs after reload (`configSnapshotDiff`) — which services need restart. |
| `provenance.ts` | Types for “which file/layer set this key” (filled by the adapter). |

`DevctlConfig` also carries runtime-only fields set at load: `repoRoot`, `configPath`, `provenance`. They are not authored in YAML.

Current schema version: `CurrentVersion = 1`.

## `domain/service/`

| File | Role |
|------|------|
| `services.ts` | Lifecycle **string** constants (`STARTING`, `HEALTHY`, …), `Runtime` (live row), `startupPlan` / `shutdownPlan` / `shutdownPlanExact`, `resolveStartRequest`, `dependentsClosure`, `profileEnvironment`. Cycle detection lives in the config validator; plans assume a valid graph. |
| `lifecycle.ts` | `LEGAL_TRANSITIONS` / `canTransition` / `transition`. Illegal edges throw `KindConfiguration`. |
| `policies.ts` | `StartupPolicy`, `RestartPolicy`, `HealthPolicy` — interpret YAML (`never` / `on_failure` / `always`, wait-for-healthy, retry budget). |
| `container-limits.ts` | Parse `memory` / `cpus` / `pids_limit` into a Docker/Podman shape. |
| `watch.ts` | Pure helpers for file-watch restart (paths, ignore globs). |

Waves: `startupPlan` returns `Plan { profile, steps, waves, blockers? }`. A configured profile clips the dependency closure to `profile.services ∪ selected`. Independent services share a wave (`Promise.allSettled` in the orchestrator); the next wave waits only for members a later step depends on with `condition: service_healthy`. Shutdown reverses dependencies unless `shutdownPlanExact` (stop only the named set).

## `domain/status.ts`

Wire/UI snapshots: `StartRequest`, `StatusSnapshot`, `IdentitySnapshot`, `ProxySnapshot`, `McpSnapshot`, `ReloadResult`, `TraceResponse`, `CredentialEntrySnapshot`, log/LLM page aliases used across RPC. Keep this module free of adapter classes.

`StartRequest.auto` is **internal**. Only health-triggered restarts set it so the restart counter is not reset.

## `domain/identity/`

| File | Role |
|------|------|
| `identity.ts` | `Identity` value type, `configuredServiceAccounts`, `identityBlockers` (start must not launch SA services without ADC). |
| `google-status.ts` | `GoogleStatus` DTO (gcloud installed, ADC, email, project source). |

User vs service identity stay separate types. The proxy route decides which one is used; nothing “falls back” silently.

## `domain/logs/`

| File | Role |
|------|------|
| `logs.ts` | `LogRecord` / ingest / filter / page / facets / parser plugin type. Barrel for the rest. |
| `types.ts` | Level names, sources. |
| `parse.ts` | Infer level from free-form lines. |
| `filter.ts`, `pagination.ts` | Query algebra and cursors. |
| `redact.ts` | Record-level redaction. |
| `record.ts`, `ids.ts` | Normalize records; trace/span/request ids. |
| `display.ts` | Formatting helpers shared with TUI. |
| `severity.ts` | Level ordering (`INFO+`). |
| `regex.ts` | Safe search compilation. |
| `python-literal.ts`, `otlp-value.ts`, `any-value.ts` | Decode nested log payloads (Python literals, OTLP AnyValue). |

## `domain/http/`

Named outbound recipes (not the reverse proxy):

| File | Role |
|------|------|
| `recipes.ts` | Which recipes a service env references; implicit start dependencies; `effectiveStartupDependencies`. |
| `json-path.ts` | Output extraction from JSON bodies. |
| `jwt.ts` | JWT expiry for recipe cache (`cache.jwt`). |

## `domain/llm/`

| File | Role |
|------|------|
| `llm.ts` | `LlmCall`, paging, `redactLlmCall`, `stripLlmBodies`. |
| `types.ts` | Source/driver strings, `LlmCall` (including optional `caller`). |
| `match.ts` | Filter matching. |
| `redact.ts` | Body/header redaction. |
| `caller.ts` | Normalize caller names; header / spend-log / completion-body extraction. |

## `domain/traffic/`

| File | Role |
|------|------|
| `traffic.ts` | Barrel: `TrafficCall`, paging, redact, payload builders. |
| `types.ts` | Call, payload, filter, page types. |
| `match.ts` | Filter matching including body search. |
| `redact.ts` | `redactTrafficCall` / `stripTrafficBodies`. |
| `payload.ts` | HTTP/gRPC body views (pretty JSON, gRPC base64 + optional JSON text). |

## `domain/telemetry/`

| File | Role |
|------|------|
| `types.ts` | Span tree DTOs. |
| `otlp.ts` | OTLP JSON shapes we accept. |
| `otel-env.ts` | Env keys injected for in-process OTLP (`OTEL_*`). |
| `span-kind.ts` | Span kind constants. |

## `domain/net/`

Loopback policy used by MCP, web, proxy, and doctor:

| File | Role |
|------|------|
| `hosts.ts` | `isLoopbackBindHost`, `isLoopbackHostname`, `isLoopbackPeer`, `formatHostPort`. |
| `ports.ts` | Port holder types for doctor / `freePort`. |
| `mcp-port.ts` | Default MCP port derivation. |

Never bind `0.0.0.0` from domain defaults; adapters must refuse non-loopback hosts.

## `domain/doctor/types.ts`

`Report`, `DoctorProgress`, `DoctorRuntimeContext`, issue records. Application and TUI import these instead of adapter doctor classes.

## `domain/session/session.ts`

`PersistedState`, `PersistedProcess` — what `state.json` contains (PIDs, profile, ports, session id). Recovery logic that *inspects* processes is an adapter (`recover.ts`).

## `domain/ui/preferences.ts`

`TuiConfig`, keybinds, MCP tool lists, `TuiPreferencePatch`. Persistence is the config adapter. `dismissed_notifications` stores notice ids (for example `update:0.10.0`).

## `domain/notifications.ts`

Operator-facing notices. First kind is `update`, built from `UpdateCheck`. Visibility is a receipts policy (dismiss forever vs snooze). Presentation owns the banner; GitHub HTTP stays in `adapters/update`.

## `domain/update.ts`

`UpdateCheck` and `formatUpdateStatus` (pure formatting). GitHub HTTP is `adapters/update`.

## When you add a domain type

1. Put the invariant here (validation of *values*, not of YAML syntax).
2. YAML syntax and unknown keys stay in `adapters/config`.
3. If presentation needs a DTO, prefer `domain/status.ts` or a focused domain module over inventing a parallel type in the TUI.
