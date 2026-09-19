# Runtime

This page is the live service lifecycle: plans, spawn, health, restart, watch, reload, tasks, exec.

## Data in the supervisor

| Structure | Meaning |
|-----------|---------|
| `runtimes: Map<string, Runtime>` | State, health, pid, ports, last_error |
| `ports: Map<string, Record<string, number>>` | Assigned named ports (`http` → 8000) |
| `clientEnv` | Last real client `process.env` per service |
| `serviceProfile` / `serviceProfileEnv` | Profile used at last spawn |
| `processMeta` | argv, cwd, startTime for adoption matching |
| `restartRequired` | Names whose config changed incompatibly |

`Runtime` is domain (`domain/service/services.ts`). Only `setState` (via lifecycle session) should mutate it, going through `canTransition`.

## Start waves

`startupPlan(cfg, selected, profile)`:

1. Resolve selected names (profile list, or explicit services, or current profile).
2. Expand dependencies (YAML `dependencies` **plus** implicit HTTP recipe services from env refs). When the profile exists in config, clip that closure to `profile.services ∪ selected` so omitted members stay remote.
3. Topological waves: a service starts in the first wave where all in-set dependencies are in earlier waves.
4. Parallelism inside a wave.
5. Leftover `${services.X.*}` / HTTP recipe refs to services not in the start set become `Plan.blockers`.

Orchestrator then:

- Identity blockers (no ADC but SA required) plus env blockers → `fail` those names, continue others
- `claimIfAlreadyUp` skips spawn
- `assignPendingPorts` (including `auto`)
- `startOne` per name in the wave
- Before the **next** wave: `awaitWaveHealth` polls members that a later wave depends on with `condition: service_healthy` until healthy or `startup.timeout_seconds` (default 30s). The last wave only waits inside `startOne` when `startup.wait_for_healthy` is set.

`startOne` hooks: `hooks.pre_start` / `post_start` as `ProcessRuntime.runOnce`. Empty command (`commandEmpty`) is a config error unless the service is container-only.

## Stop waves

`shutdownPlan` reverses dependencies (dependents first). `stop []` means every non-stopped runtime. SIGTERM → wait `grace_seconds` → SIGKILL (`ProcessManager.stop`). Health watches and restart timers cleared via `HealthMonitor.forget`.

## Restart policies (`domain/service/policies.ts`)

YAML `restart.policy`: `never` | `on_failure` | `always` (and legacy `enabled: true` → on_failure).

`HealthMonitor.onExit`:

- Ignore if generation mismatch or state is `FAILED`/`STOPPING`
- Else if policy says restart and budget remains → `StateRestarting`, backoff, `actions.restart(..., { auto: true })`
- Else `StateFailed`

Unhealthy probes increment a streak; after `HEALTH_RESTART_STREAK` consecutive failures, same budget is used. Consecutive healthy probes reset.

## File watch

`ServiceWatchers` (`service-watch.ts`) uses `watch.paths` / `ignore` / `debounce_ms`. A burst schedules `restart([name])`. Disabled unless `watch.enabled`.

## Config watch

`watchConfig` on the `.devctl` directory (and plugin files’ mtimes). Debounced `reloadSupervisor`. Plugin load errors are logged; missing configured plugin **types** fail validation. A running proxy applies the new route table in place when listen binds are unchanged.

## Tasks and exec

- `tasks` in YAML: `run_task` RPC → `runOnce` with merged env and optional dependencies started first (see supervisor `runTask`).
- `exec`: one-shot command in a service’s cwd/env without replacing the long-running process. MCP keeps this default-off.

## Containers vs host processes

If `service.container.image` is set, `startContainer` (Docker or Podman). Port map uses `container.ports` (target) vs assigned host ports. Env omits the `process` layer (`includeProcess: false`) so the developer’s whole shell is not in `docker inspect`. Token URL is omitted (container loopback ≠ host loopback).

## Port assignment

`adapters/net/ports.ts` `assignPorts`. Duplicate configured ports fail validation. In-use ports fail at assign/start (doctor also reports them). Auto ports pick a free loopback port and inject `SERVICE_PORT` / named values into env.

## Persistence

`persistState()` writes `state.json` (session id, profile, per-service pid/state/ports). Used only for recovery, not as a live API. The live API is `status` RPC.

## Failure modes worth knowing

| Symptom | Code path |
|---------|-----------|
| Wave throws “one or more services failed to start” | `allSettled` had a rejection after logging |
| Health timeout | `awaitWaveHealth` → `KindHealthCheck` / fail that service |
| Orphan after reload | Still in `runtimes`, gone from `cfg.services`; `stop` uses a one-name wave and `forgetService` |
| Auto-restart used stale env | `clientEnv` is in-memory only; new daemon has none — user must `restart` from a client |
