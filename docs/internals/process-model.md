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

Before adopting anything, it takes over the service FIFOs the previous daemon left (`adapters/process/fifo-stdio.ts`):
1. Open every FIFO recorded in `streams.json`.
2. Stop the drainer that daemon's sentinel started (`fifo-sentinel.ts`).
3. Hold the FIFOs in this daemon's own sentinel.
4. Replay the drain spool (`fifo-drain.ts`) with the original read times.
5. Read the FIFOs directly (`fifo-reader.ts`).

The daemon has exactly one reader for a stream at every point, so each stream stays in the order it was written. Output of a service that exited while no daemon ran is kept.

A reader with nothing to read (`fifoChunks`) retries after 1 ms, doubling, then sleeps:
- One 100 ms timer checks every sleeping reader's FIFO with a single non-blocking read. That bounds how late output, an end of stream, or a stop is noticed, as the per-stream poll did.
- Where `probeFifoWatch` finds that a watch reports FIFO writes (Linux inotify; kqueue and FSEvents do not), a reader sleeps after 8 ms and an `fs.watch` on the FIFO's path, held for that one sleep, wakes it at the write. Bun does not open a file to watch it on Linux, so a FIFO with no writer left cannot block the daemon there; `fifo-reader.test.ts` holds that.
- A watch does not report a close. `ProcessManager` kicks a service's readers when its process exits, so they read the end of the stream at once; the timer finds every other end.
- A watch that fails, or three checks in a row that find output the watch did not report (`splice(2)` into a FIFO before Linux 6.5, for one), puts that stream back on the timer alone.

The drainer's readers sleep the same way. Its plan names each FIFO's path unless that would take the plan, which is one argument, past 96 KiB.

## Orphans and zombies

Stopping a service signals its whole process group. A shell-wrapped service's shell then often dies before it has collected its child, so the child is orphaned already dead. The kernel hands an orphan to the nearest child subreaper, else to PID 1, and a PID 1 such as `sleep infinity` never collects it: one zombie per restart, for the life of the container.

`adapters/process/subreaper.ts` makes the daemon a child subreaper (`prctl(PR_SET_CHILD_SUBREAPER)` through `bun:ffi`) and `OrphanReaper.tick` runs from the daemon's one-second timer:
- It reads the daemon's children from `/proc/<pid>/task/<tid>/children` (every pid in `/proc` when the kernel has no such file), every fifth tick while none is dead and every tick while one is.
- Children Bun spawned are Bun's to collect, because it reads their exit status. A service's own pid is never collected here, also for a minute after the service is gone.
- Any other dead child is collected with `waitpid(pid, WNOHANG)` once three scans in a row have seen it, with the same start time. Bun collects its own within one turn of its event loop, so one that is still there is not Bun's.
- A dead member of a running service's group that is not the service itself was never spawned here and is collected at once.

`supervisor.reap_orphans` unset means on where `readPid1` finds a PID 1 that does not reap (`sleep`, `tail`, `pause`, `cat`); `true` and `false` override. It works only on Linux with glibc (`libc.so.6`). A service that a restarted daemon adopted is not that daemon's descendant, so its orphans still go to PID 1. `status --json` carries `daemon.orphanReaper` (`on`, or `unavailable` when it was wanted and could not start), and `devctl doctor` warns only when nothing reaps.

## Signals

`runDaemon` registers SIGINT/SIGTERM → `supervisor.shutdown(stopOnExit(cfg.shutdown))` so an admin `kill` still flushes async log writes. RPC `shutdown` schedules `shutdown()` after 50ms so the response can leave the socket first.

## Multiple instances

One supervisor per `repoID`. Two terminals in the same checkout share one daemon. Two clones get two daemons. There is no multi-repo supervisor (see `docs/platform-bets.md`).
