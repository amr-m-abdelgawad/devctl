# Process model

`devctl` is two OS processes for a running session: a **client** and a **supervisor**. The TUI, extra CLI commands, MCP, and the web UI are additional clients of that same supervisor. They never share an in-memory `Supervisor` instance with each other.

## Who owns what

| Process | Entry | Owns |
|---------|-------|------|
| Client | `bin.ts` → `createClient()` → Commander / OpenTUI | Parsing flags, discovering config, dialing or spawning the daemon, rendering, offline commands (`setup`, `doctor` without a daemon, `config validate`) |
| Supervisor | `bin.ts` → `runDaemon` via hidden `_supervisor` | Lock, socket, runtimes, orchestrator, log store, proxy, MCP listener, web listener, config watch, identity refresh |

`presentation/` must not call `ProcessRuntime.start` for user services. The supervisor does.

## Spawning the supervisor

`ensureSupervisor` in `adapters/rpc/controller.ts`:

1. `tryDial(repoRoot)` with a short timeout. If a socket answers, reuse it.
2. Otherwise spawn a **detached** child:
   - Source: `bun` + `src/bin.ts` + `--config <path> _supervisor --repo <root>`
   - Compiled binary: `devctl --config <path> _supervisor --repo <root>` (`Bun.isStandaloneExecutable`)
3. Child stderr goes to `~/.devctl/state/<repoID>/bootstrap.log` (rotated; last 5 kept).
4. Parent waits until the socket accepts (up to 15s) then `unref()`s the child so the CLI can exit.
5. If bind fails, the parent SIGKILLs the child (and the process group on Unix) so tests do not leak orphans.

The child’s environment is a **copy of `process.env` at spawn**. Runtime mutations on the client after spawn are not visible unless forwarded later as `client_env` on start/restart RPC.

## Finding which daemon to talk to

`resolveDaemonTarget` in `adapters/daemon/daemon.ts` (used by attach, status, down, daemon logs):

1. `--repo` wins.
2. Else config discovery (`discover`) from cwd or `--config`.
3. Else, if no explicit `--config`, scan `~/.devctl/state/*/state.json` for a `repo_root` that is cwd or an ancestor. That keeps a live daemon reachable after `.devctl/` is deleted.

`openController` (CLI start/stop) vs `openAttach` vs `openTui`:

| Function | Starts a supervisor? | Missing config |
|----------|----------------------|----------------|
| `openController(..., startSupervisor=true)` | Yes via `ensureSupervisor` | Throws (`load`) |
| `openAttach` | Never | May still dial via state-scan |
| `openTui` | Yes if no daemon and config parses | Setup mode / boot error in the TUI |

Effective config **once attached** is always `config_snapshot` from the daemon, not a local reparse. Local YAML is used only to decide whether to spawn a fresh daemon.

## Lock and socket

On `Supervisor.run()`:

1. **Acquire the lock first** (`devctl.lock` in the session dir). The lock proves no other supervisor owns this repo.
2. Then remove a stale Unix socket and `listen`.
3. Windows uses `\\.\pipe\devctl-<repoID>` — not a filesystem path; stale unlinks are skipped.

Deleting the socket before taking the lock used to let a losing second process unlink a live peer’s socket. Do not restore that order.

RPC auth: `rpc-token` in the session dir, sent as `Envelope.auth` on every request. Compared with `secretMatches` (`shared/bearer.ts`). Failed auth never subscribes the connection to the event bus.

## Handshake

After connect, the client calls `ping`. Response:

```json
{ "session": "<id>", "version": "<product-version>", "protocol": 2 }
```

`RPC_PROTOCOL_VERSION` in `version.ts` is independent of the product version. Same protocol + different `VERSION` is compatible (warning only). Missing `protocol` is a **legacy** daemon: only `logs` / `logs_page` / `logs_stats` and `shutdown` (`down`) are allowed until the user runs `devctl down`.

## Attach, detach, down, quit

| User action | Supervisor | Services |
|-------------|------------|----------|
| `devctl start` (CLI returns) | Stays up | Stay up |
| `devctl` / `devctl attach` | Unchanged | Unchanged |
| `devctl down` | `shutdown` RPC then exit | Stopped unless `--keep-services` |
| TUI `q` | Follows `shutdown.stop_services_on_exit` (or a confirm) | Stop or keep |
| Client crash | Unchanged (detached spawn) | Unchanged |
| Supervisor crash | Gone | Orphans recovered on next `run()` via `recover.ts` |

Services are spawned detached on every platform (`ProcessManager.start`), which is what lets them outlive the supervisor in the `--keep-services` and crash rows. On POSIX that is `setsid`, so a stop signals the service's whole process group. On Windows it keeps them out of the job object that kills children when the parent exits, `windowsHide` stops console windows opening, and a stop runs `taskkill /T /F` on the tree.

`StartRequest.detach` still exists on the wire for compatibility; `devctl start` always leaves the daemon running. `--detach` is deprecated.

## Session recovery

`adapters/daemon/recover.ts` reads `state.json`, inspects PIDs (`inspectProcess` / `processAlive` / command+cwd+start time), and **adopts** still-living processes instead of killing them. A stored PID is never trusted alone. Containers are adopted through `adapters/containers`.

## Signals

`runDaemon` registers SIGINT/SIGTERM → `supervisor.shutdown(stopOnExit(cfg.shutdown))` so an admin `kill` still flushes async log writes. RPC `shutdown` schedules `shutdown()` after 50ms so the response can leave the socket first.

## Multiple instances

One supervisor per `repoID`. Two terminals in the same checkout share one daemon. Two clones get two daemons. There is no multi-repo supervisor (see `docs/platform-bets.md`).
