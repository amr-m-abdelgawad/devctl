# Logs

All service stdout/stderr, proxy events, health checks, authentication events, and `devctl` internal lines go through one log manager on the supervisor.

Sources you will see: `stdout`, `stderr`, `health`, `auth`, `devctl`, `proxy`, and `otlp` (when `telemetry.otlp.enabled` is on).

Each line is stored as an OpenTelemetry-style record — body, attributes, severity, and optional `traceId`/`spanId` — so structured JSON keeps its fields and a line joins its trace. Enabling the OTLP receiver and viewing traces are covered in [Telemetry](telemetry.md).

## Buffer and persistence

- In-memory circular buffer: `logs.max_memory_events` (default 50,000). Retention stays O(1) per line even after the buffer fills.
- The live ring lives in a Bun Worker behind `LogStore` when running from source or npm, so parse and search do not stall the supervisor event loop. The main thread only receives page/facet/export results (and a cached snapshot for `status`). Compiled standalone binaries (`bun build --compile`) keep the ring in-process — Bun 1.4.0 cannot resolve the worker script inside a single-file executable. If the worker fails to start, the daemon falls back to the in-process store rather than hanging.
- Ingest truncates lines longer than 16 KiB and skips `JSON.parse` on payloads larger than 64 KiB. Regex search is already capped (pattern length, nested quantifiers).
- Optional persistence under `~/.devctl/logs/` (`persistence.enabled`, `directory`, `retention_days`, `max_session_logs`).
- Ingest is a bounded channel; UI updates batch (~30ms) so a noisy service cannot freeze the TUI.
- The detached supervisor's own bootstrap stderr (before it has a config, so before any of the above even starts) is a separate file with its own rotation — the last 5 boot attempts are kept, each overwrite-proof against the next. See `devctl daemon logs` in the [CLI reference](cli.md).

## Pagination and facets

Queries (CLI, TUI, MCP) return a bounded, cursor-paged slice instead of the whole matching history: a page defaults to the latest 500 matching events, capped at 5,000. The cursor is opaque (carries the daemon session and an internal per-event sequence number) and pages both backward (older) and forward (newer) without duplicating or dropping events that share the same millisecond — a plain timestamp boundary can't make that guarantee once two events land in the same millisecond and a page cuts between them. `since`/`until` keep working as ordinary timestamp filters alongside the cursor. Exporting (`/export`, `devctl logs export`) still reads the entire matching history — page size never truncates an export.

Facets — the total matching count, plus per-service/level/source counts (each computed under every *other* active filter, not its own) — come from a separate, lightweight stats query with no event payload. The TUI refreshes them every two seconds while its logs screen is open, and immediately on a filter change, a clear, or reconnecting, so the filter chips' counts and the log pane title stay accurate even though the TUI itself only ever holds a bounded page rather than the full history.

## TUI (Logs tab)

- `f` focuses search. `/` stays the command line. Matches are highlighted in the log line (plain or `/regex`). Dashboard tail uses the same search filter.
- `e` / `/filter` — ERROR and above.
- `p` / `/pause` — freeze the live stream.
- `z` / `/fullscreen` — hide header and nav so the stream fills a small editor terminal. `z` or `esc` exits.
- `t` / `m` — timestamp and metadata columns (persist in `tui.json`).
- `w` / `/wrap` — wrap every line (default) → clip with ellipsis → unwrap only the selected row.
- `g` — jump to latest. Leaving the tail pins the view (`pinned · +N new`).
- `←`/`→` or click a chip — cycle service filters. Digits `1`–`4` jump nav tabs, not log sources.
- `\\` / `/split` — second pane on the same live stream, with its own service filter. Shared search. `|` focuses the other pane.
- `enter` — details overlay (body summary, attributes table, severity number, `traceId`/`spanId`). A ◎ marker on the list means the row has a trace; enter again (or **view trace**) opens a full-width waterfall. The solid block is the span; the dim track is unused time in the window. `j`/`k` selects a span; Enter or double-click opens that span's logs overlay (`esc` returns to the waterfall).
- `/trace <id>` — set search to that request/trace id. Enter in the details overlay on a row that has an id does the same.
- `command+c` (macOS) or `ctrl+c` (Linux/Windows) — copy the highlighted selection. Remap with `keybinds.copy`.
- `/export [path]` — write the **current** filters. Default file: `~/.devctl/exports/devctl-logs-<timestamp>.log`.
- `/exports` or the **open folder** chip — reveal that directory.
- `/history [id]` — load a persisted session (`LogManager.listSessions`).
- `/regex`, `/since`, `/until` — search and time range (`until` is exclusive of later lines).

Headlines wrap to the pane width with OpenTUI word wrap (`wrapMode="word"` on the message cell; chrome columns stay fixed). Clip mode uses native ellipsis. `j`/`k` moves the highlight.

## CLI

```bash
devctl logs [svc…] [--level] [--search] [--regex] [--source] [--since] [--until] [--trace] [--attribute key=value] [--json]
devctl logs                        # latest page (same as MCP get_logs); pass --all for the full match set
devctl logs -f                     # keep printing new matching events until interrupted
devctl logs --output FILE          # same filters, write a file (full history, not just one page)
devctl logs export --output FILE   # explicit export subcommand
devctl logs --trace <id>           # spans plus correlated logs for that trace
devctl daemon logs [-f]            # the supervisor's own bootstrap stderr, not service logs
```

## Related

- [TUI](tui.md)
- [CLI](cli.md)
- [Security](security.md)
