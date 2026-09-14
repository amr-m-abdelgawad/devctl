# How to read the code

`devctl` is a modular monolith. There is one TypeScript tree (`app/src/`), two long-lived process kinds, and four faces that all talk to the same supervisor. Read it as a **control plane**, not as a library of independent CLIs.

## The one-sentence model

A **client** (CLI, TUI, or a short-lived `devctl` invocation) dials a **supervisor** over a per-repo Unix socket (named pipe on Windows). The supervisor owns processes, containers, logs, the proxy, MCP, and the web UI. Presentation code paints state and sends commands; it does not spawn your services.

```text
you type `devctl start api`
        │
        ▼
bin.ts → presentation/cli → Controller.call("start", …)
        │
        ▼  newline JSON on ~/.devctl/state/<repoID>/devctl.sock
Supervisor.dispatch("start")
        │
        ▼
StartService.execute → ServiceOrchestrator.start
        │
        ▼
ProcessRuntime.start / startContainer
        │
        ▼
Bus.publish(ServiceStarted) → RPC event stream → TUI / other clients
```

If you remember only that diagram, the rest of the tree falls into place.

## First files to open (in order)

Do not start in `presentation/tui/App.tsx` or `adapters/daemon/supervisor.ts`. Those files are large because they *coordinate*. Start at the edges, then walk inward.

| Order | File | What you learn |
|-------|------|----------------|
| 1 | `app/src/bin.ts` | One entry. Client composition + daemon launcher handed to Commander. |
| 2 | `app/src/bootstrap/client.ts` | Everything a CLI/TUI process is allowed to do without being the supervisor. |
| 3 | `app/src/bootstrap/daemon.ts` | How the supervisor is wired: processes, tokens, logs, orchestrator, MCP/web factories. |
| 4 | `app/src/application/commands.ts` | Named use cases (`StartService`, `ReloadConfig`, …). Thin; they call ports. |
| 5 | `app/src/application/orchestrator.ts` | Dependency waves, health waits, stop/restart plans. |
| 6 | `app/src/adapters/rpc/controller.ts` | How a client finds or spawns the daemon and maps methods to TypeScript. |
| 7 | `app/src/adapters/rpc/server.ts` | Framing, auth, event fan-out. |
| 8 | `app/src/adapters/daemon/supervisor.ts` | Host: lock, recover, watch, `dispatch()`, coordinators. |
| 9 | `app/src/domain/config/types.ts` | The in-memory config snapshot after load. |
| 10 | `app/src/domain/status.ts` | RPC/JSON snapshot shapes shared by every face. |

After those ten files, pick a subsystem page in this guide and read the modules it names.

## How to chase a behavior

Pick the face the user touched, then stay on the command path. Do not grep the whole repo for a string and patch the first hit.

### CLI: `devctl start api`

1. `presentation/cli/cli.ts` → `addStart` in `lifecycle.ts`.
2. `runtime.openController(...)` (from `ClientRuntime` in `bootstrap/client.ts`).
3. `Controller.start` in `adapters/rpc/controller.ts` → RPC `"start"`.
4. `Supervisor.dispatch` case `"start"` → `commands.startService.execute`.
5. `ServiceOrchestrator.start` → `LifecycleSession` methods on the supervisor (env, ports, identity, proxy).
6. `ProcessManager.start` or `startContainer`.

### TUI: pressing Enter on Services

1. `presentation/tui/hooks/use-app-keyboard.ts` (and `keyboard-screens.ts`) maps keys.
2. `use-command-dispatcher.ts` / `use-lifecycle.ts` call `controller.start` / `stop` / `restart`.
3. Same RPC path as the CLI from there.
4. `use-daemon-events.ts` applies `Bus` events to React state. Screens in `screens/` only render.

### MCP: `start_services`

1. HTTP on loopback: `presentation/mcp/server.ts`.
2. Tool table: `presentation/mcp/tools.ts` (`callMcpTool`).
3. Tools call `McpHost` (the supervisor’s facade), which uses the same orchestrator methods as RPC.

### Config: “why was this YAML rejected?”

1. `adapters/config/discover.ts` (where the file came from).
2. `load.ts` → `decode.ts` → `merge.ts` → `migrate.ts` → `validate.ts`.
3. Unknown fields: `strict.ts` + `schema/devctl.config.schema.json` (kept in parity by `schema-parity.test.ts`).
4. Authoring rules the schema does **not** state: `skills/devctl-onboard/references/authoring.md`.

### A Google / IAP failure

1. Domain policy: `domain/identity/identity.ts` (`identityBlockers`).
2. Token mint: `adapters/google/token.ts`.
3. Probe / login: `adapters/google/google.ts`.
4. Injection into requests: `adapters/proxy/proxy.ts` and `adapters/http/runtime.ts`.
5. Diagnostics copy: `adapters/doctor/doctor.ts`.

## Naming that used to mean something else

The living code does **not** have `ServiceManager` / `IdentityManager` as types. Older comments and `docs/devctl-architecture.md` use those names. The equivalents today:

| Historical name | Current owner |
|-----------------|---------------|
| Service Manager | `ServiceOrchestrator` + `Supervisor` runtimes map |
| Process Manager | `ProcessManager` (`adapters/process/processes.ts`) implementing `ProcessRuntime` |
| Identity Manager | `IdentityCoordinator` + `TokenManager` |
| Proxy Manager | `ProxyCoordinator` + `ProxyServer` |
| Log Manager | `LogStore` (`worker-log-store.ts` wrapping `LogManager`) |
| Application Controller | `Controller` (RPC client) + `ClientRuntime` |

`Supervisor` is the daemon host. It is allowed to be large. New orchestration logic still belongs in `application/` or a focused coordinator, not a new `*Manager` god object.

## Tests as a map

Almost every production module has a sibling `*.test.ts`. Architecture tests in `app/src/architecture.test.ts` document forbidden imports with examples. Integration tests that need a real supervisor use `bootstrap/test-supervisor.ts` (subclass of `Supervisor` with fake Google). Prefer reading a test next to a confusing function before adding `console.log`.

## What not to read first

- `docs/devctl-architecture.md` — product intent, not the current tree.
- `presentation/tui/overlays/*` — modal UI chrome; they sit on top of screens and do not own domain behavior.
- `presentation/mcp/docs.generated.ts` and `guide.generated.ts` — copies of markdown; edit the sources and run `bun run sync-guide`.
- `presentation/web/assets.generated.ts` — bundled SPA; edit `app/web/` and `bun run build:web`.

## After you can navigate

Read [layers](layers.md) so you do not introduce an import CI will reject, then the subsystem you are changing.
