# MCP server for coding agents

`devctl` can expose a **localhost Streamable HTTP** MCP server so Claude, Cursor, Codex, and Kilo Code can read status, logs, and config, and start or stop services.

The listener lives on the **supervisor** (the same process that owns services and the proxy). The TUI only toggles it and copies config. Agents need a URL; a stdio child of the TUI would die when the TUI exits.

Default is **off** (`mcp_enabled` in `~/.devctl/tui.json`). Once on, the supervisor applies that preference itself at startup — whether it was spawned by the TUI or by a plain CLI command — so the listener comes back on the next `devctl start` too, not only while the TUI is attached.

## Enable it

```mermaid
flowchart LR
  open["/mcp or Settings → MCP page"] --> listen["Listen ON"]
  listen --> copy["Copy JSON / TOML"]
  copy --> agent["Claude / Cursor / Codex / Kilo"]
  agent --> http["127.0.0.1:port/mcp"]
  http --> sup["Supervisor"]
```

MCP is **not** a nav tab. Flip **Listen** (`space` / `enter`). The header shows an **MCP** chip when it is running.

The default port is derived from the repo so checkouts do not collide:

`18700 + (parseInt(repoID.slice(0, 8), 16) % 600)` → **18700–19299**.

Change it with `←` / `→` or `devctl mcp --port`. An override is persisted as `mcp_port` only when it is not the derived default. If the preferred port is busy, the supervisor walks upward until it finds a free one.

The server binds **`127.0.0.1` only**. Mutating tools require `Authorization: Bearer` with a short session token. Copied snippets include that header. Tool output never includes tokens or raw secret env values. `get_status` reports MCP running/address/port, not the bearer token.

## CLI

```text
devctl mcp                 # URL + four snippets
devctl mcp --on [--port N]
devctl mcp --off
devctl mcp --json
```

`--on` starts a supervisor if needed. `--off` stops the listener only.

## Tools and resources

| Tool | What it does |
|------|----------------|
| `list_services` | Name, state, health, ports, pid, last error |
| `get_service` | One service plus command/cwd/ports (env redacted or left as `${…}` refs) |
| `get_status` | Profile, session, identity flags, proxy, log counts, MCP listen |
| `get_logs` | Filtered logs, capped at 200 events per page, secrets redacted. Pass `cursor` from the previous `next_cursor` to page forward with no duplicate or same-millisecond-lost lines; `since`/`until` are plain timestamp filters for a fresh query |
| `list_profiles` | Config profiles and members |
| `get_config` | Merged summary: project, services, routes, proxy paths |
| `run_doctor` | Doctor report |
| `start_services` | Named list, or a `profile`. Omitted names use `profile`, then the active session profile, then the first configured profile — never every service. No profile and no names fails closed |
| `stop_services` | Named list, or all started services when omitted. Also stops every transitive dependent of a named service — never its dependencies |
| `restart_services` | Named list; touches only those services, not dependents, unless `cascade: true`. Start still expands dependencies |
| `reload_config` | Reload `.devctl` |

Resources (always-fresh reads): `devctl://status`, `devctl://services`, `devctl://logs`, `devctl://config`, `devctl://doctor`.

Doctor may report ports “in use” while your own services hold them — that is expected after a successful start.

## Related

- [TUI](tui.md)
- [CLI](cli.md)
- [How it fits together](overview.md)
- [Security](security.md)
