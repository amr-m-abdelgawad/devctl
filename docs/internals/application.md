# Application

`app/src/application/` is use cases: **explicit commands** and the **service orchestrator**. It talks to domain + ports only.

## Commands — `commands.ts`

Classes with `execute(...)`. They exist so CLI, TUI, MCP, and RPC dispatch the same call, not so we have a framework.

| Command | What it does |
|---------|----------------|
| `StartService` | Brands profile/service ids, calls `orchestrator.start` |
| `StopService` | Brands names, `orchestrator.stop` |
| `RestartService` | Optional `cascade` / `clientEnv` |
| `StartProfile` | `StartService` with a `ProfileId` |
| `StartProxy` / `StopProxy` | `DaemonCommandHost.startProxy/stopProxy` |
| `ReloadConfig` | `host.reload()` |
| `SetServiceEnvironment` | Selects `services.<name>.environments.<env>` for one service (session state; does not restart) |
| `RefreshIdentity` | `host.refreshIdentity({ probeServiceAccounts: true })` |
| `RunDoctor` | `DoctorRunner.run` |
| `GetServiceStatus` | `host.snapshot()` |
| `GetStartupPlan` / `GetShutdownPlan` | Pure `startupPlan` / `shutdownPlan` |
| `ResolveStart` | Pure `resolveStartRequest` |

`commandsForHost(host, doctor, orchestrator?)` is what bootstrap passes into `Supervisor`. If `orchestrator` is omitted, start/stop/restart go to the host (tests).

`asServiceId` is the string→brand helper at this boundary.

## Orchestrator — `orchestrator.ts`

`ServiceOrchestrator` implements `ServiceOrchestratorPort`.

`bind(session)` must run before `start`/`stop`/`restart`. The session is a `LifecycleSession` implemented by `Supervisor` (ports, env, identity, proxy, persist). The orchestrator does not import `Supervisor`.

### `start`

1. Resolve names/profile (`resolveStartRequest`). Empty `profile` from RPC/MCP is “omitted”, not “clear stored profile”.
2. Store `client_env` per service **only if the request carried one** (MCP/internal starts must not blank a previous real client env).
3. Reset restart counts unless `req.auto`.
4. Compute waves; compute `identityBlockers`; `fail()` blocked services.
5. Auto-start proxy unless `proxySuppressed`.
6. Skip names `claimIfAlreadyUp` (adopted running processes).
7. Assign ports for pending names; record `serviceProfile` only for names about to spawn.
8. For each wave: `startOne` in parallel; then `awaitWaveHealth`.
9. `persistState()`.

`startOne` (private): lifecycle STARTING → prepare identity → resolve env/cwd → run `pre_start` hook → `ProcessRuntime.start` or `startContainer` → STARTING/RUNNING → health monitor `startHealth` → `post_start` hook. Failures go through `session.fail`.

### `stop`

Unknown names error. Names still in `runtimes` but removed from config (reload orphans) are stopped without a graph. Dependency shutdown uses `shutdownPlan` unless exact.

### `restart`

Stop then start with stored profile/env. `cascade` also restarts dependents (`dependentsClosure`). `auto: true` preserves restart budget.

## Health monitor — `health-monitor.ts`

Owns:

- Per-service **generation** (ignore late exits/probes after stop/restart)
- Interval health ticks (`HealthCheckerFactory.lookup(type)`)
- Unhealthy streak → restart (`HEALTH_RESTART_STREAK`)
- Healthy streak reset (`HEALTH_RESET_STREAK`)
- Crash handling via `onExit` + `RestartPolicy`
- Shared retry budget (`restarts` map) for crash **and** unhealthy relaunch
- Backoff timers

`fail()`-induced kills must not look like crashes (`StateFailed` short-circuit in `onExit`).

Do not put probe HTTP in this file; checkers are adapters (`adapters/health/health.ts` plus plugins).

## Other application modules

| File | Role |
|------|------|
| `client-runtime.ts` | `ClientRuntime` and `Controller` **types** (no implementations). Presentation depends on these. |
| `setup-starter.ts` | Builds the starter `.devctl/config.yaml` text (used by `devctl setup`). |
| `compose-import.ts` | Maps a Compose file into starter service YAML (setup / MCP onboarding helpers). |

## Adding a use case

1. If it is a daemon mutation, add a method on `DaemonCommandHost` / `ServiceOrchestratorPort` or a new command class that calls an existing one.
2. Wire it in `commandsForHost`.
3. Expose it on RPC `dispatch`, then CLI/TUI/MCP as needed.
4. If it is client-only (validate YAML, format doctor), put it on `ClientRuntime` and implement in `createClient`.
5. Do not subscribe to `Bus` inside a command to “wait until started” — `start()` already awaits health.
