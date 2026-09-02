# How it fits together

`devctl` is one product with four faces on the same supervisor.

```mermaid
flowchart TB
  tui["TUI — OpenTUI screens and keys"]
  cli["CLI — start / stop / logs / auth"]
  mcp["MCP — http://127.0.0.1:port/mcp"]
  sup["Supervisor"]
  disk["~/.devctl/state/repoID/"]

  tui --> sup
  cli --> sup
  mcp --> sup
  sup --> procs["Child processes"]
  sup --> proxy["Proxy + token endpoint"]
  sup --> logs["Log buffer"]
  sup --> disk
```

Nothing in the application knows your services by name. The supervisor reads `.devctl/`, starts argv (or explicit shell) processes, injects resolved env, and reports health.

## Supervisor

The supervisor is the long-lived process. It:

- Starts, stops, and restarts services in dependency waves
- Optionally starts the proxy and the MCP listener
- Ingests stdout/stderr, health, auth, and proxy events into one log buffer
- Persists session state under `~/.devctl/state/<repoID>/` (`state.json`, `devctl.lock`, and on Unix `devctl.sock`)

`repoID` is the first 16 hex characters of `sha256(absolute repo root)`. Two checkouts get two state directories. A leftover `~/.devctl/sessions/<id>/` is migrated once.

`devctl start` always ensures a daemon and leaves it running after the command exits (`--detach` is deprecated and no longer changes that). `devctl` (no args) and `devctl attach` dial the session socket: `devctl.sock` on macOS/Linux, `\\.\pipe\devctl-<repoID>` on Windows. Attach never starts a supervisor; the default TUI may. `devctl down` stops the daemon (and, unless `--keep-services`, its services).

Override the home directory with `DEVCTL_HOME` (default `~/.devctl`).

## TUI

The TUI is an OpenTUI React app. It attaches to a supervisor and paints status, logs, identity, doctor, config, and settings. It does not own child processes. Closing the TUI can stop services or detach, depending on `shutdown.stop_services_on_exit` — see [TUI](tui.md).

Startup locates and attaches to an already-running daemon first, independent of whether the on-disk config still parses — an attached daemon's `config_snapshot` (its own last-known-good in-memory config) is always the effective config, never a local reparse. Local parsing only comes into play when no daemon is reachable: a valid config spawns a fresh one, a missing config opens **setup**, and anything else (invalid YAML, a schema violation) is a real boot error with nothing started. Once attached, a `/reload` (or an external edit picked up by the config-file watcher) refetches the snapshot on success; a failed reload leaves a banner up under the nav bar until the next one succeeds.

## CLI

The CLI is the same controller over the same socket. Use it for scripts, CI, and one-shot status. See [CLI](cli.md).

## MCP

Coding agents cannot keep a TUI child alive, so MCP is a **localhost Streamable HTTP** server on the supervisor. Default off. See [MCP](mcp.md).

## Configuration vs preferences

| What | Where |
|------|--------|
| Services, profiles, proxy, Google project | `.devctl/config.yaml` and modular YAML |
| Machine overlay (gitignored) | `.devctl/config.local.yaml` and `~/.devctl/config.local.yaml` |
| TUI theme, keys, MCP listen flag | `~/.devctl/tui.json` (or `DEVCTL_TUI_CONFIG`) |
| Session / lock / socket | `~/.devctl/state/<repoID>/` |
| Persisted logs | `~/.devctl/logs/` |
| Log exports | `~/.devctl/exports/` |
| Credential files (if no keychain) | `~/.devctl/credentials/` (mode `0600`) |

## Typical loop

```mermaid
flowchart LR
  setup[".devctl/config.yaml<br/>or devctl setup"] --> validate["devctl config validate"]
  validate --> doctor["devctl doctor"]
  doctor --> run["devctl<br/>or devctl start"]
  run --> logs["Logs"]
  logs -.-> auth["Auth only if Google is required"]
```

Local-only services (the [demo platform](../examples/demo-platform/README.md)) run without `gcloud`.

## Related

- [Installation](installation.md)
- [Configuration](configuration.md)
- [TUI](tui.md)
- [CLI](cli.md)
- [MCP](mcp.md)
