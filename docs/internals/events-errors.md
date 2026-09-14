# Events and errors

## Event bus (`shared/events.ts`)

`Bus` is an in-process pub/sub with a bounded recent buffer (daemon uses 2048).

```ts
type BusEvent = {
  type: EventType;
  timestamp: string;
  service?: string;
  payload?: Record<string, unknown>;
};
```

Known types (string constants — extra plugin strings are allowed):

| Type | Typical publisher |
|------|-------------------|
| `ServiceStarted` / `ServiceStopped` / `ServiceFailed` | Orchestrator / health monitor |
| `ServiceStateChanged` / `ServiceHealthChanged` | Supervisor `setState`, health monitor |
| `LogReceived` | Log store path |
| `TokenRefreshed` / `TokenRefreshFailed` | TokenManager |
| `AuthenticationChanged` | Identity coordinator |
| `ProxyStarted` / `ProxyStopped` / `ProxyRequest` | Proxy coordinator / proxy server |
| `ConfigurationChanged` / `ConfigurationReloadFailed` | Reload |
| `SessionRecovered` | Recover |

`subscribe(handler, types?)` — empty `types` means all. RPC server uses that after auth.

**Do not** wait on an event to complete a command. `start()` returns a `Plan` after waves finish (or throw). Events exist so other clients repaint.

## Errors (`shared/errors.ts`)

`DevctlError` carries `kind`, `hint`, `service`, optional `cause`.

| Kind | CLI exit |
|------|----------|
| `configuration`, `configuration_missing`, `service_not_found`, `dependency` | 2 |
| `authentication`, `token`, `iap` | 3 |
| `authorization`, `impersonation` | 4 |
| `process_start` | 5 |
| `health_check` | 6 |
| `proxy` | 7 |
| `general` | 1 |

Success is 0. `configuration_missing` is distinct so setup can run and `loadOrEmpty` can swallow **only** that kind.

Helpers: `newError`, `wrapError`, `hintError`, `humanMessage`, `serializeError` (RPC), `parseError` (client), `exitCode`, `isKind`.

RPC errors serialize to `{ error, kind, hint, service }` on the envelope. The client reconstructs `DevctlError`.

## Retry (`shared/retry.ts`)

Network/token operations may retry with backoff. Configuration errors must not. If you add a retry, gate it on kind (or on the callee), never a blanket `catch`.

## Other shared modules

| File | Role |
|------|------|
| `bearer.ts` | Constant-time secret compare (`secretMatches`, `bearerMatches`) |
| `headers.ts` | Header lookup without throwing on malformed requests |
| `redaction.ts` | Detector used when presentation cannot import the secrets adapter |
| `repo-id.ts` | `sha256` → 16 hex |
| `mcp-token.ts` | MCP token TTL helpers |
| `warnings.ts` | Mute noisy GCP metadata logs; hold stderr for TUI |
| `sliding-window.ts` | Rate/window helpers |
| `terminal-restore.ts` | Reset terminal modes on TUI exit (including crashes) |

`types.ts` at `src/` is only `Envelope`. Do not dump more shared types there.
