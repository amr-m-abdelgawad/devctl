# Logs

All service stdout/stderr, proxy events, health checks, authentication events, and `devctl` internal lines go through one log manager on the supervisor.

Sources you will see: `stdout`, `stderr`, `health`, `auth`, `devctl`, plus proxy lines.

## Buffer and persistence

- In-memory circular buffer: `logs.max_memory_events` (default 50,000). Retention stays O(1) per line even after the buffer fills.
- Optional persistence under `~/.devctl/logs/` (`persistence.enabled`, `directory`, `retention_days`, `max_session_logs`).
- Ingest is a bounded channel; UI updates batch (~30ms) so a noisy service cannot freeze the TUI.
- The detached supervisor's own bootstrap stderr (before it has a config, so before any of the above even starts) is a separate file with its own rotation — the last 5 boot attempts are kept, each overwrite-proof against the next. See `devctl daemon logs` in the [CLI reference](cli.md).

## Pagination and facets

Queries (CLI, TUI, MCP) return a bounded, cursor-paged slice instead of the whole matching history: a page defaults to the latest 500 matching events, capped at 5,000. The cursor is opaque (carries the daemon session and an internal per-event sequence number) and pages both backward (older) and forward (newer) without duplicating or dropping events that share the same millisecond — a plain timestamp boundary can't make that guarantee once two events land in the same millisecond and a page cuts between them. `since`/`until` keep working as ordinary timestamp filters alongside the cursor. Exporting (`/export`, `devctl logs export`) still reads the entire matching history — page size never truncates an export.

Facets — the total matching count, plus per-service/level/source counts (each computed under every *other* active filter, not its own) — come from a separate, lightweight stats query with no event payload. The TUI refreshes them every two seconds while its logs screen is open, and immediately on a filter change, a clear, or reconnecting, so the filter chips' counts and the shown/total badge stay accurate even though the TUI itself only ever holds a bounded page rather than the full history.

## TUI (Logs tab)

- `f` focuses search. `/` stays the command line.
- `e` / `/filter` — ERROR and above.
- `p` / `/pause` — freeze the live stream.
- `z` / `/fullscreen` — hide header and nav so the stream fills a small editor terminal. `z` or `esc` exits.
- `t` / `m` — timestamp and metadata columns (persist in `tui.json`).
- `w` / `/wrap` — clip → unwrap the selected row → wrap every long line.
- `g` — jump to latest. Leaving the tail pins the view (`pinned · +N new`).
- `1`–`9` jump log sources when chips overflow.
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
devctl logs -f                     # keep printing new matching events until interrupted
devctl logs --output FILE          # same filters, write a file (full history, not just one page)
devctl logs export --output FILE   # explicit export subcommand
devctl daemon logs [-f]            # the supervisor's own bootstrap stderr, not service logs
```

## Related

- [TUI](tui.md)
- [CLI](cli.md)
- [Security](security.md)
