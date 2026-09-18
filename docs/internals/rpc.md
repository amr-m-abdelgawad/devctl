# RPC

The supervisor protocol is **newline-delimited JSON** over a Unix domain socket (Windows named pipe). It is not JSON-RPC 2.0 (MCP is). Shared shape: `Envelope` in `app/src/types.ts`.

```ts
type Envelope = {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  kind?: string;
  hint?: string;
  service?: string;
  event?: unknown;
  auth?: string; // client → supervisor only; never echoed
};
```

## Framing and backpressure

`adapters/rpc/server.ts`:

- Each TCP/pipe connection has a string buffer split on `\n`.
- First authenticated request subscribes that connection to `Bus` and starts pushing `{ event }` lines.
- Outgoing queue cap: 2000. Pure events (`id` missing, `event` set) may be dropped (oldest droppable). RPC **responses** are never dropped — the client would hang on `id`.
- Socket `error` (EPIPE / ECONNRESET) is logged; it must not crash the daemon.

`adapters/rpc/controller.ts` `Client`:

- Writes `{ id, method, params, auth }`.
- Matches responses by `id`.
- Default call timeout 30s; `run_task` / `exec` use a 24h timeout.
- `ping` timeout 8s; bootstrap wait 15s; `tryDial` 200ms.

## Authentication

`readOrCreateRpcToken(repoRoot)` stores a random secret in the session directory. Every request must present it. Comparison is constant-time (`shared/bearer.ts` `secretMatches`). Wrong token → `{ error: "unauthorized", kind: "authorization" }` and no event subscription.

## Compatibility

`RPC_PROTOCOL_VERSION` (currently `2`) is bumped only when the wire format changes in a way old clients must not ignore. Product `VERSION` can move independently.

Incompatible daemon: `assertMethodAllowed` blocks everything except `logs`, `logs_page`, `logs_stats`. `down` calls `shutdown` on the raw `Client` (bypassing that gate) so users can recover.

## Methods

`Supervisor.dispatch` in `adapters/daemon/supervisor.ts`. Params are loosely parsed with `adapters/rpc/params.ts` (`asStringArray`, `asLogFilter`, …).

| Method | Params (conceptual) | Result | Notes |
|--------|---------------------|--------|-------|
| `ping` | `null` | `{ session, version, protocol }` | Handshake |
| `start` | `{ services, profile, detach, client_env }` | `Plan` | Empty services + profile → profile set; else resolve against active profile |
| `stop` | `{ services }` | `null` | Empty → all non-stopped |
| `restart` | `{ services, cascade, client_env }` | `null` | |
| `run_task` | `{ name, client_env }` | `{ task, code, stdout, stderr }` | Configured `tasks.*` |
| `exec` | `{ service, command, print_env, client_env }` | `{ service, code, stdout, stderr, environment? }` | Service cwd/env; MCP default-off |
| `auth_refresh` | `null` | `IdentitySnapshot` | Probes SAs; does **not** wipe the whole token cache |
| `status` | `null` | `StatusSnapshot` | |
| `logs` | filter + optional `export` | `{ events }` | |
| `logs_page` | filter + `cursor` / `direction` / `limit` | `LogPage` | |
| `logs_stats` | filter | `LogFacets` | Cheap poll for TUI |
| `get_trace` | `{ trace_id }` | `TraceResponse` | |
| `trace_request` | `{ request_id }` | `TraceResponse` | Proxy `X-Devctl-Request-ID` |
| `llm_calls_page` | LLM filter + page | `LlmCallPage` | |
| `get_llm_call` | `{ id }` | call or empty | Includes bodies (redacted downstream) |
| `traffic_calls_page` | traffic filter + page | `TrafficCallPage` | |
| `get_traffic_call` | `{ id }` | call or empty | Includes bodies (redacted downstream) |
| `proxy_start` | `null` | `null` | Clears suppression |
| `proxy_stop` | `null` | `null` | Sets suppression so `start()` will not auto-bind |
| `mcp_start` | `{ port? }` | `null` | Explicit port wins; else saved TUI pref |
| `mcp_stop` | `null` | `null` | |
| `mcp_rotate` | `null` | `null` | New MCP bearer |
| `web_start` | `null` | `{ url }` | |
| `web_stop` | `null` | `null` | |
| `mcp_set_tools` | `{ disabled: string[] }` | `{ disabled_tools }` | Full deny-list, not a delta |
| `reload` | `null` | `ReloadResult` | |
| `set_service_env` | `{ service, name }` | `{ service, env }` | Per-service named overlay; session state only. Does not restart. |
| `config_snapshot` | `null` | `DevctlConfig` | **RPC only**, never MCP. Unredacted. |
| `auth_invalidate` | `null` | `null` | Clears `TokenManager` |
| `shutdown` | `{ stop_services }` | `null` | Schedules process exit |

Unknown method → `KindGeneral`.

`client_env` is the **calling process** environment (`osEnviron()`), so dotenv/process layers follow the developer’s shell, not the daemon’s stale spawn env.

## Controller

`Controller` implements the application `Controller` interface. Each method is a typed wrapper around `call`. `close({ detach, shutdownSupervisor })` decides whether to send `shutdown`.

`configSnapshot()` is the source of truth for attached UIs. After `/reload`, the TUI replaces `controller.cfg` from this RPC.

## Events on the same socket

After auth, the server writes `{ event: BusEvent }` with no `id`. Clients register `onEvent`. High-frequency `LogReceived` must not assume every event arrives (queue drop). The TUI log view pages the log store rather than relying solely on the bus for history.

## Related types

Snapshot DTOs: `domain/status.ts`. Do not add RPC fields only in the adapter; presentation and MCP consume those types too.
