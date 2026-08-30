# Logs

All service stdout/stderr, proxy events, health checks, authentication events, and `devctl` internal lines go through one log manager on the supervisor.

Sources you will see: `stdout`, `stderr`, `health`, `auth`, `devctl`, plus proxy lines.

## Buffer and persistence

- In-memory ring: `logs.max_memory_events` (default 50,000). The TUI follows this cap.
- Optional persistence under `~/.devctl/logs/` (`persistence.enabled`, `directory`, `retention_days`, `max_session_logs`).
- Ingest is a bounded channel; UI updates batch (~30ms) so a noisy service cannot freeze the TUI.

## TUI (Logs tab)

- `f` focuses search. `/` stays the command line.
- `e` / `/filter` — ERROR and above.
- `p` / `/pause` — freeze the live stream.
- `z` / `/fullscreen` — hide header and nav so the stream fills a small editor terminal. `z` or `esc` exits.
- `t` / `m` — timestamp and metadata columns (persist in `tui.json`).
- `w` / `/wrap` — clip → unwrap the selected row → wrap every long line.
- `g` — jump to latest. Leaving the tail pins the view (`pinned · +N new`).
- `space` — multi-select service chips. `1`–`9` jump log sources when chips overflow.
- `enter` — details overlay (full message, pid, stream, request_id, identity).
- `cmd+c` (macOS) or `ctrl+shift+c` — copy visible lines. Remap with `keybinds.copy`.
- `/export [path]` — write the **current** filters. Default file: `~/.devctl/exports/devctl-logs-<timestamp>.log`.
- `/exports` or the **open folder** chip — reveal that directory.
- `/history [id]` — load a persisted session (`LogManager.listSessions`).
- `/regex`, `/since`, `/until` — search and time range (`until` is exclusive of later lines).

Long lines fold with a `▸N` marker. `j`/`k` moves the highlight and unwraps that row.

## CLI

```bash
devctl logs [svc…] [--level] [--search] [--regex] [--source] [--since] [--until] [--json]
devctl logs --output FILE          # same filters, write a file
devctl logs export --output FILE   # explicit export subcommand
```

## Related

- [TUI](tui.md)
- [CLI](cli.md)
- [Security](security.md)
