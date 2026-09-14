# Bootstrap

Composition roots are the only production files allowed to import every layer. If you need a new adapter in the CLI, add it here, not in `presentation/`.

## `bin.ts`

```ts
import "./adapters/google/gcp-env.ts";  // METADATA_SERVER_DETECTION / timeouts before any Google client
silenceGcpMetadataWarnings();
await execute(createClient(), runDaemon);
```

`execute` is Commander. The default action (no subcommand) launches the TUI. `_supervisor` is registered by `addSupervisor` and calls `runDaemon(repo, config)`.

## Client process — `createClient`

`bootstrap/client.ts` returns a `ClientRuntime` object (see `application/client-runtime.ts`). It is a bag of closures, not a class.

Wired here:

| Area | Implementations |
|------|-----------------|
| TUI prefs | `adapters/config/tui-preferences.ts` |
| Config | `load`, `loadOrEmpty`, `loadPath`, `validate`, `discover`, `configDiff` |
| Session files | `storage.ts`, `logs.ts` (export, historical sessions) |
| Google (offline) | `detectGoogle`, `loginGoogle`, `logoutGoogle`, `TokenManager.refresh` |
| Doctor | `RunDoctor` + `createDoctorRunner(createDoctorHost({ tokens }))` |
| Plans | `GetStartupPlan`, `GetShutdownPlan`, `ResolveStart` (pure domain, no daemon) |
| Daemon | `openController`, `openAttach`, `openTui`, `findDaemon`, `tryDial` |
| Setup | `createStarterConfig`, `runSetup` (presentation/cli/setup — called only from bootstrap) |
| Updates | `githubUpdate()` |

`ClientRuntime` is the contract presentation depends on. When you add a CLI-only capability that needs I/O, add a method to the type **and** the object in `createClient`. Do not import the adapter from the CLI module.

## Daemon process — `createDaemon`

`bootstrap/daemon.ts` builds:

1. `Clock` (`systemClock`) and `FileSystem` (`osFileSystem`)
2. `ProcessManager` and `Bus(2048)`
3. `TokenManager` with `googleTokenProviders()`
4. `ServiceOrchestrator(processes, clock)` — not yet bound to a session
5. Log store via `createDaemonLogStore` (worker thread when possible; in-process fallback; standalone compiled binaries skip the worker)
6. `Supervisor` with factories for MCP (`McpHttpServer`) and web (`WebHttpServer`)
7. `createCommands: (host) => commandsForHost(host, doctorRunner, orchestrator)`

`runDaemon` uses **`loadOrEmpty`**, not `load`. A missing config boots **setup mode** so `devctl mcp --on` can exist before `.devctl/` exists. Invalid YAML still throws.

After `createDaemon`, `Supervisor.run()` acquires the lock, recovers the session, starts watchers, and binds the socket (see [process model](process-model.md)).

## Test fixtures

| Module | Use |
|--------|-----|
| `bootstrap/test-supervisor.ts` | `Supervisor` subclass: real processes, empty token providers, fake `detectGoogle` unless overridden. In-process log store. |
| `bootstrap/test-client.ts` | Commander root wired like production for CLI tests. |
| `bootstrap/daemon.test.ts` / `client-runtime.test.ts` | Wiring regressions. |
| `bootstrap/tui-hooks.test.ts` | Hook tests that need a client workspace. |

Production adapters must not import these fixtures. Tests (layer `test`) may.

## Doctor host vs runner

- `DoctorHost` — adapters the checks need (tokens, filesystem probes, gcloud).
- `DoctorRunner` — port: `run(cfg, onProgress, runtime) => Report`.
- `RunDoctor` — application command wrapping the port.
- CLI `devctl doctor` runs **in the client process** against loaded YAML (does not require a daemon). The TUI doctor can pass live `DoctorRuntimeContext` (ports in use, proxy bind) from the attached snapshot.

## Default listeners

`defaultMcpListener` / `defaultWebListener` always bind `127.0.0.1`. Tests inject fakes through `DaemonDeps.createMcpListener` / `createWebListener`.
