# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Opt-in loopback Telemetry & Trace Explorer (`web`, off by default, port `18900`). Read-only GET API (no token, no CORS, Host allowlist) serving a bundled SPA: services dashboard, SVG trace waterfall, dependency graph, and client-derived rate/latency/CPU charts. `devctl web status|start|stop`; `devctl status` prints a `WEB` line. See [Telemetry](docs/telemetry.md).

## [0.7.0] - 2026-09-12

### Added

- OpenTelemetry-aligned telemetry. Logs are now OTel-shaped records — body, attributes, `severityNumber`/`severityText`, optional `traceId`/`spanId`, and a `resource` — instead of a flat message. Structured JSON from pino, bunyan, zap, logrus, structlog, ECS, GELF, and OTLP-shaped lines is mapped into body + attributes + severity + ids; a leading timestamp before the JSON is stripped and retried; and an unrecognized JSON object renders as a `key=value` summary rather than raw braces. See [Telemetry](docs/telemetry.md).
- Opt-in OTLP/HTTP+JSON receiver (`telemetry.otlp`, off by default, loopback-only, default port `4318`). Accepts `POST /v1/logs` and `/v1/traces`; when enabled, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, and `OTEL_SERVICE_NAME` are injected into managed host processes (containers and any value you set yourself are left alone). The listen port is validated against the proxy, token-endpoint, and gRPC-route ports.
- Request tracing. The proxy (HTTP and gRPC) emits one span per request — method, route, status, duration, identity — and propagates a `traceparent` plus `X-Devctl-Request-ID`, so a service's own OTLP spans and logs join the request's trace. An in-memory span store correlates spans and logs by trace id and resolves a request id to its trace.
- TUI. The log details overlay shows an attributes table, severity, and `traceId`/`spanId`; a `◎` marker flags rows that have a trace; and a full-width Trace waterfall overlay renders the span tree (Enter or double-click a span opens its logs).
- CLI. `devctl logs` gains `--trace <id>` (span tree plus correlated logs), `--request-id`, `--attribute key=value`, and `--json` (JSONL records).
- MCP. New `get_trace`, `trace_request`, `get_requests`, and `recent_errors` tools; `get_logs` gains `trace_id`, `request_id`, and `attribute` filters and returns body/attributes/severity. All output is redacted.
- Docs. New [Telemetry](docs/telemetry.md) page; Logs, MCP, Proxy, and Configuration updated for the record model, the receiver, and the trace tools.

### Changed

- Log persistence is now JSONL (one OTel record per line) instead of space-delimited text, so reload is lossless (attributes, ids, severity). The format is detected per session directory, and older space-delimited sessions still load.
- Secret redaction now walks nested `body`/`attributes`, span events, and span status messages, and runs at ingestion — so nothing unredacted reaches the TUI, CLI, MCP, or the on-disk log files.
- The demo platform's `telemetry` service now cycles the awkward JSON shapes the parser accepts (no severity, no message key, GELF, prefixed JSON, access logs, nested secrets), posts OTLP/HTTP+JSON logs and traces, and probes the proxy with a W3C `traceparent` so the Logs ◎ marker, attributes table, Trace overlay, and Proxy request traces have live data. `telemetry.otlp` is enabled on `127.0.0.1:18418`.

### Fixed

- Log list headlines no longer clip at the pane edge. Messages wrap to the column using OpenTUI word wrap, clip mode uses ellipsis, and wrapping every line is the default.
- The trace overlay waterfall uses the full width. Enter or double-click a span opens its logs overlay; `esc` returns to the timeline.
- Table columns keep a one-character gutter, so a value that fills its cell no longer runs into the next column.
- Trace waterfall bars use a muted track for unused time; only the solid block is the span. Proxy request spans start at request begin (the recorded timestamp is completion), so they line up with OTLP spans.
- OTLP severity decoding keeps valid OTLP severity numbers (e.g. 10/`INFO2`, 20/`ERROR4`) and enum-name strings (`SEVERITY_NUMBER_ERROR`) instead of remapping them through pino's numeric convention, which had turned some OTLP levels into TRACE/DEBUG or UNKNOWN and could disagree with the shown severity text.
- A JSON log carrying a top-level `body` field is no longer dropped for non-OTLP records; its value is used as the message.
- OTLP body and attribute strings are length-capped like the stdout lane, and int64 attribute values beyond `Number.MAX_SAFE_INTEGER` are preserved as strings rather than silently rounded.
- Proxy spans always carry valid W3C ids, and a bare `X-Devctl-Request-ID` is no longer adopted as a trace id (only a real `traceparent` sets one), so unrelated requests are not merged into one trace.

## [0.6.0] - 2026-09-11

### Added

- `route.response_headers` adds headers to every response on the route, overriding whatever the upstream sent — most often CORS `Access-Control-Allow-*` for a browser that loads a micro-frontend, Module Federation remote, or iframe from another origin and then calls back through the proxy. A CORS preflight (`OPTIONS` carrying `Access-Control-Request-Method`) is answered directly with those headers and a `204`; it is not forwarded, since the upstream may not handle `OPTIONS` and IAP would reject an unauthenticated preflight. Any other `OPTIONS` is proxied normally, still with the headers applied. Rejected on a gRPC route.

## [0.5.0] - 2026-09-10

### Added

- gRPC proxy routes (`transport: grpc`). A dedicated loopback HTTP/2 (h2c) listener forwards every gRPC stream to one `https://` upstream over HTTP/2 + TLS, injecting the route's IAP token (`Authorization` + any `auth.headers`) into each RPC via the same minting/refresh path as HTTP routes. A gRPC client — e.g. a Temporal worker behind IAP — connects plaintext to the local `listen` port (`Client.connect(host, tls=False)`) and stays entirely token-free; per-RPC injection means expiry is handled with no timer in the app. Targets self-hosted Temporal behind a GCP IAP HTTPS load balancer (Temporal Cloud's mTLS + API key is out of scope).

## [0.4.1] - 2026-09-10

### Fixed

- IAP routes using a custom `client_id`/`client_secret` (user identity) now mint an id_token with the correct `aud`. The refresh-token exchange sends `audience` (the IAP client id) rather than google-auth-library's `target_audience`, which returned `aud = client_id` and was rejected by IAP as an invalid JWT audience.

## [0.4.0] - 2026-09-10

### Added

- `${identity.user}` resolves in configured environment values to the running developer's own detected Google identity (gcloud/ADC), so shared config can map it onto a service's own variable without a hardcoded, team-unfriendly value — e.g. `LOCAL_USER_EMAIL: ${identity.user}`. The same value is also injected automatically as the runtime variable `DEVCTL_USER_EMAIL`. Empty when no identity is detected.
- `route.auth.headers` injects extra request headers alongside `Authorization` on a token-minting route; `${token}` in a value is replaced with the same minted token (e.g. `identity-token: ${token}`), and literals pass through. This lets the proxy fully satisfy an upstream's auth expectations without changing the upstream or the calling service. `get_config` lists the configured header names.

## [0.3.2] - 2026-09-10

### Fixed

- A separate IAP credentials file now works from a modular `.devctl/proxy/routes.yaml`. `proxy.credentials` (and `gateway`, `enabled`, `token_endpoint`) were silently dropped by the modular proxy loader, so routes fell back to gcloud ADC and failed with a client mismatch despite the setting. Modular proxy files now honor the same fields as the top-level `proxy` block, and `get_config` surfaces `proxy.gateway`, `proxy.credentials`, per-route `auth.credentials`, and service-reference upstreams. The authoring guide's allowlist documents `credentials` on `proxy` and `route.auth`.
- Windows resource sampling no longer stalls the daemon's poll on a slow PowerShell launch — the helper spawn is bounded and degrades to an empty sample.

## [0.3.1] - 2026-09-10

### Added

- IAP routes can mint tokens for a custom `client_id` from a separate gcloud authorized_user credentials file via `auth.credentials` (or a proxy-wide `proxy.credentials` default), instead of the default gcloud ADC — so ADC stays intact for GCS/Firestore and other Google SDK calls. The path accepts `~`, absolute, or repo-relative forms; the file's `refresh_token` must belong to the route's `client_id`, and the file can supply the `client_secret` when the route omits it.
- MCP `get_doc` returns the full text of one embedded documentation page. `search_docs` returns short snippets for discovery; pass a hit's `path` to `get_doc` to read the whole page.

### Fixed

- `proxy.gateway` now honors an explicit `expose: false` on a service instead of publishing it anyway; unknown keys under a service's `expose` object are rejected.
- IAP custom-client token minting resolves the OAuth secret only when refreshing, so a still-valid cached token keeps working after its environment secret is removed rather than failing with a 502. A rejected custom-client request is now classified with IAP guidance.
- Configuration rejects a `client_secret` that mixes literal text with an environment reference — it must be a plain literal or exactly `${NAME}` / `${env.NAME}`.
- Proxy documentation rendering: a stray code fence that hid the per-service routes section is removed.

## [0.3.0] - 2026-09-09

### Added

- Optional IAP route `client_id` plus `client_secret` mints user ID tokens with that OAuth client instead of ADC's default client. Put `${NAME}` or `${env.NAME}` in `client_secret` to read the secret from the environment at mint time. MCP `get_config`, status snapshots, CLI `proxy status`, and the TUI route details show `client_id` and env-ref templates (never a resolved secret).
- MCP `search_docs` searches the compiled-in product documentation and onboarding skill.
- `service.expose` (and `proxy.gateway` for every HTTP-capable service) synthesizes a host-based, `auth: none` proxy route that addresses the service by name. The proxy resolves the **current** assigned port at request time, so a restart onto a new auto port does not require a proxy reload or consumer change. A hand-written route of the same name always wins. Routes may set `upstream.service` / `upstream.port` instead of a fixed `url`.
- `${services.<name>.url}` and `${services.<name>.host}` resolve through the proxy when the target is exposed (hub mode), otherwise to the direct loopback address.

### Changed

- The docs site homepage, logos, and default TUI `devctl` theme use the forest/mint website palette.

## [0.2.5] - 2026-09-09

### Added

- TUI `/restart --cascade` (`-c`) and `R` confirm (`c` = cascade) restart dependents the same way CLI and MCP already do.
- Empty TUI `/run` and `/exec` open a picker; Enter on a Config task row runs that task.
- MCP `run_task`, `start_proxy`, and `stop_proxy` wrap the existing supervisor RPCs. Auth login and config write stay CLI/TUI-only.
- TUI log search highlights matches (plain and regex) and the dashboard tail honors the same search.
- TUI first-run Enter runs the 9-step setup wizard and attaches the daemon without restarting the process.
- `devctl config import compose` (and TUI `/import compose`) maps modeled Compose fields and lists dropped ones; `--write` never invents unknown schema keys.
- Opt-in `service.watch` restarts one service when listed paths change (debounced, ignored globs, never the whole repo by default).
- Configuration reload hot-applies a changed `plugins` path list; editing an already-imported plugin file still asks for a supervisor restart.
- TUI log split panes (`\\` / `/split`), `/trace <id>`, and Stats sparklines from a 60-sample supervisor ring.
- TUI chords use **command** on macOS and **ctrl** on Linux/Windows. Help and the status bar label the OS modifier. The copy chord copies the highlighted selection; `esc` twice quits.
- Slash overlay second-word suggestions and usage hints (`/auth`, `/restart`, `/import`, and similar).
- Log store truncates lines over 16 KiB and skips JSON parse for payloads over 64 KiB; the daemon can keep the ring on a worker thread.
- CI `check:coverage` fails the suite when aggregate function or line coverage drops below 86%.
- CI `check:dead` (Knip) and `check:dup` (jscpd) reject unused files/exports and copy-paste clones.

### Changed

- The supervisor is split further into proxy, MCP, identity, environment, and resource-sampler coordinators plus a dedicated RPC server. CLI, TUI, and MCP still share the same commands.
- Docs no longer claim an implicit proxy listen of `127.0.0.1:8080`. `proxy.listen.port` is required when `proxy.enabled` is true (validate exits 2); `devctl proxy start` with port `0` exits 7. Setup still writes 8080 as a starter.

### Fixed

- `service.watch` debounce of `0` or a negative value falls back to the default instead of disabling the debounce.
- A detached supervisor child is reaped on shutdown and in tests so `down` does not leave an orphan listening on the session socket.

## [0.2.4] - 2026-09-08

### Added

- Ports-and-adapters layout is enforced: `bun run check:architecture` (and a CI job) rejects inward-layer imports, and [docs/architecture.md](docs/architecture.md) is the living layer map.
- Structured JSON-per-line parsing covers metric telemetry (`metric_name` / `value`), nginx-style access logs, and OpenTelemetry OTLP records (`body.stringValue`, attribute arrays), not only pino/zap application logs.

### Changed

- `devctl update` and TUI `/update` detect how this binary was installed (npm, npx, Homebrew, GitHub Release, source) and, for npm and Homebrew, run that channel's upgrade. `--check` and `--json` still report only. `/version` stays a check.
- Application code is split into `presentation`, `application`, `domain`, `ports`, `adapters`, `shared`, and `bootstrap`. CLI, TUI, and MCP still share the same commands; the supervisor is no longer a single god file.

### Fixed

- Proxy, token endpoint, and MCP listeners refuse IPv6 unspecified (`::`) and other non-loopback binds, not only `0.0.0.0`.
- A failed spawn no longer leaves the service stuck in `STARTING`, which blocked every later start of that name.
- A crash restart is no longer skipped when a stale health probe still reports `HEALTHY` after the process has already exited.
- Restarting several services no longer applies the first target's profile environment to the rest. A later start that omits `--profile` (or sends an empty profile) keeps each service's stored profile instead of clearing it.
- Session recovery restores each leftover process's own profile (and re-resolves that profile's current environment) instead of assigning every service the last daemon-wide profile.
- A no-op configuration reload no longer clears outstanding `restart_required` names. A successful spawn (including crash restart) drops that service from the list; claiming an already-running process does not, and a later health-wait failure does not restore names that already spawned.
- `start --profile` against an already-running process no longer rewrites that service's stored profile without applying it. TUI start of named services omits the selected profile the same way CLI `devctl start api` does; start of the current profile still sends it.
- Restarting a service keeps its profile name but re-resolves that profile's environment from the current configuration, so edited profile variables take effect.
- HTTPS upstreams can complete WebSocket upgrades (the proxy used `http.request` for every upgrade).

## [0.2.3] - 2026-09-04

### Added

- Structured (JSON-per-line) logs from pino, bunyan, zap, logrus, and similar loggers are parsed instead of shown as a raw blob: `message`/`msg`/`text`, `level`/`severity` (including pino's numeric levels), and `request_id`/`trace_id`-style fields populate the normal log columns. The full JSON stays available — pretty-printed in the log details overlay (`enter`), searchable, and unabbreviated in persisted session files and log exports.
- The Services screen's env var list shows the full variable name and value (no more truncation at a fixed column width), sorts variables set directly in that service's own `environment.vars`/`environment.defaults` to the top in a distinct color (ahead of ones supplied by dotenv, a profile, secrets, plugins, or runtime injection), and clicking a variable opens a scrollable panel with its full, wrapped value.
- `examples/demo-platform` gained a `telemetry` service (in `minimal`/`backend`/`full`) that emits pino/zap-style JSON-per-line logs instead of plain text, specifically to exercise the Logs screen's structured-log parsing.

### Changed

- The Logs screen's level column shows `—` instead of `UNKNOWN` for a line with no recognizable severity keyword — the common case for plain stdout/stderr output, not an anomaly worth shouting about.

### Fixed

- `findPortHolder` no longer crashes with an unhandled "Executable not found in $PATH" error when `lsof` or `fuser` isn't installed (common on minimal containers and some WSL/Linux images). It now degrades to "holder unknown" instead.
- The Proxy screen's "No proxy routes" empty state (and every other `Banner`/`EmptyState`, e.g. the Credentials screen's action banner) no longer clips its text mid-sentence in narrow panes. `Banner` had a hardcoded height of 2-3 content rows regardless of how many lines the body/hint actually wrap to; it now sizes to its wrapped content, matching the pattern already used by the proxy "no requests yet" panel next to it.
- Stopping a service could get permanently stuck showing STOPPING instead of STOPPED, and — because a stop plan stopped dependents wave by wave and one wave's failure aborted the rest — every other service queued behind it in a multi-service stop never got touched at all, still showing RUNNING. A stop plan now attempts every wave regardless of earlier failures, and a service whose kill genuinely fails lands on FAILED (with the error visible) instead of being stranded in STOPPING forever.
- Stopping a service while it was still in its slow pre-spawn phase (resolving cloud identity, environment, or a `pre_start` hook) had no effect: the state briefly flipped to STOPPED, but the in-flight start wasn't actually cancelled, so it went on to spawn the process anyway and silently flipped the state back to RUNNING once it finished — the stop never stuck.
- The Profiles screen's per-profile service list was a single non-wrapping line — a profile with enough services just got clipped mid-name with no indication more were listed. It now wraps across multiple lines.

## [0.2.2] - 2026-09-04

# Hot Fix

- Improve target detection in the npm packagining.

## [0.2.1] - 2026-09-04

### Added

- TUI `/run <task>` and `/exec <service> -- <command…>`. Task and exec output go to Logs (`task:<name>` / `<service>:exec`). `/exec <service> --print-env` loads the same resolved environment as the CLI (dotenv, profile, secrets, plugins, runtime ports), redacted unless `/reveal` or `--reveal`.
- TUI `/diff` (config provenance), `/daemon` (supervisor bootstrap stderr), `/auth login` and `/auth logout`, `/update` (GitHub Releases check; does not overwrite the binary). `/version` runs that same check after printing the current version.

### Changed

- Documentation matches 0.2.0: empty start and `--detach`, the demo `data` profile, MCP/skills indexes, proxy auth types and WebSocket upgrades, Doctor container checks, CONTRIBUTING.md, SECURITY.md, GitHub issue/PR templates, and in-repo agent-skill pointers.
- TUI log wrap and copy strip ANSI so CSI sequences do not consume width or appear in the clipboard.
- Proxy route list wraps match and upstream instead of clipping them; `devctl proxy status` prints the host/path match.
- Idle dashboard shows leftover PIDs from the previous supervisor session (the same persisted state `devctl status` prints when the socket is down) without skipping TUI auto-spawn.
- Config screen lists named tasks.

### Fixed

- `/auth login` suspends the OpenTUI renderer before spawning `gcloud`, so ADC login output no longer overwrites the TUI. The TUI is restored when gcloud exits.
- npm launcher (`bin/devctl.cjs`) now uses universal CommonJS syntax compatible with Node.js 10+ — eliminates `SyntaxError: Unexpected token '?'` when the script is executed by an older Node distribution (e.g. the system Node bundled with a Windows installer and run from inside WSL). Running `devctl` after installing the Windows npm package from inside WSL now prints an actionable error with clear reinstall instructions instead of failing silently.


## [0.2.0] - 2026-09-04

### Added

- Native Docker and Podman services with image, container-port, environment, volume, log, health, restart, shutdown, and adoption support. Published ports bind to loopback, container exit codes feed restart policy, and the demo's opt-in `data` profile includes PostgreSQL without adding Docker to its default profiles.
- Service `pre_start` and `post_start` hooks plus named one-off tasks through `devctl run`. Hooks use the service's resolved execution context and do not rerun during automatic recovery.
- `devctl exec` and the `exec_service` MCP tool for commands or redacted environment inspection in a service's exact working directory and resolved environment.
- Realistic health startup controls (`start_period_seconds`, `unhealthy_threshold`, `healthy_reset_threshold`) and per-dependency `service_started` / `service_healthy` conditions.
- Configuration provenance across main, modular, home-local, repository-local, and synthesized layers. `devctl config diff` and `get_config_sources` explain the winning value and everything it shadowed.
- A versioned, validated plugin SDK covering environment, health, identity, tokens, logs, and proxy middleware. Custom identities carry provider-owned configuration and token keys; the included generic OIDC plugin supports discovery and client-credentials tokens.

### Changed

- Modular service and profile files load in deterministic filename order, and schema/strict-loader parity is enforced by tests.
- The demo platform exercises containers, tasks, hooks, and health-gated dependencies while preserving its existing container-free onboarding path.
- Containers receive declared profile, dotenv, keychain/secret-manager, service/container, plugin, and safe runtime environment layers without copying the developer's complete shell or devctl's internal token into inspectable container metadata.

### Fixed

- Doctor recognizes ports owned by running container services and never offers to terminate the Docker or Podman host process as a remedy.
- Completion now includes every public top-level command and the `config diff` subcommand, with a test binding completions to the CLI declaration.

## [0.1.5] - 2026-09-04

### Fixed

- Proxy WebSocket upgrades now use the same route matching, identity injection, middleware, request logging, and statistics as ordinary HTTP traffic, restoring HMR and other upgraded connections behind devctl routes. Active upgraded sockets are closed during proxy shutdown so `devctl down` cannot hang.

## [0.1.4] - 2026-09-04

### Fixed

- The npm Trusted Publishing step now marks the release tarball as an explicit local path, preventing npm 11 from interpreting it as a GitHub repository shorthand.

## [0.1.3] - 2026-09-04

### Added

- Public `@amr-m-abdelgawad/devctl` npm distribution: `npx` and global npm installs run the complete CLI/TUI through a package-local official Bun runtime, so users need only Node.js and do not download an unsigned devctl executable. Releases use npm Trusted Publishing/provenance, a strict five-file package allowlist, and clean-install smoke tests.
- GitHub Release binaries now include SHA-256 checksums and build-provenance attestations. They remain explicitly documented as unsigned Apple/Microsoft alternatives.

## [0.1.2] - 2026-09-04

### Added

- Agent skill for onboarding a repository to devctl (`skills/devctl-onboard`): a procedure for surveying what a repo actually runs — docker-compose, Procfile, per-language project files, Terraform, Kubernetes manifests, `.env` files — and authoring a `.devctl` for it, plus two reference files covering the signal-to-service mapping and the rules the config loader rejects on that the JSON Schema does not state. Installable for Claude Code, Cursor, Codex, and Kilo Code; `skills/README.md` has the per-agent setup.
- MCP `get_setup_guide` serves that same guide (sections `procedure`, `authoring`, `discovery`) directly from the binary, so an agent connected to devctl's MCP server can onboard a repository with nothing installed.
- MCP `validate_config` returns the exact issues the loader would report. With no arguments it validates what is on disk; passing `text` validates a candidate `config.yaml` through the real load pipeline — modular services and profiles, overlays, templates — before it is written. Validation was previously reachable only through the CLI.
- **Setup mode.** `devctl mcp --on` now works in a repository that has no `.devctl` at all: the daemon boots without a configuration so an agent can be pointed at the MCP server and asked to create one. Nothing is validated and no service can start until a configuration exists; `get_status` reports `setup_mode: true` so an agent can tell that state apart from a daemon that failed to start anything. Setup mode clears on the reload that finds a valid configuration, and `.devctl/` starts being watched from then on. A configuration that exists but is invalid still fails loudly, so a broken config is never silently replaced with an empty one. Every other command still fails closed with "no devctl configuration found."
- MCP tools can be enabled and disabled individually. The TUI's MCP page lists them grouped by purpose (inspect, logs, diagnostics, control, setup), each marked `read` or `write`, and `space` toggles the highlighted one — the common case being turning off the whole `control` group so an agent can read status and logs but not start or stop anything. Everything is on by default. A disabled tool is left out of `tools/list` and refused if called anyway, since an agent may still hold a tool list from before it was turned off; the refusal names the tool rather than reporting it as unknown. The setting is a deny-list (`mcp_disabled_tools` in `tui.json`), so a tool added by a later version is available without editing anything, and the daemon applies it at boot the same way it applies `mcp_enabled`. An agent cannot change it: `mcp_set_tools` is a local RPC and is deliberately absent from the MCP host surface.

### Fixed

- The reload warning for settings a running daemon cannot pick up (log capacity and persistence, auth refresh threshold, plugin paths) advised `devctl stop && devctl start`, which cannot work: `stop` deliberately leaves the daemon running and only `down` ends it, so following that advice restarted the services and left the daemon holding the stale settings. Both the daemon's log line and `devctl reload`'s note now say `devctl down && devctl start`, and share one formatter so they cannot drift apart again.
- `docs/configuration.md`'s overlay precedence diagram was drawn in the opposite direction to its own "later sources win" caption, and showed `~/.devctl/config.local.yaml` overriding the repository's own `.devctl/config.local.yaml`. The loader does the reverse — the repo-local overlay gets the last word.
- The compiled-binary CI smoke test removed its temporary directory immediately after signalling the supervisor, racing the daemon's own state and log flush and failing with "Directory not empty" after the test itself had passed. It now asks the daemon to stop, waits for it, and preserves the script's real exit status so a cleanup problem cannot redden a passing build or hide a failing one.
- The Windows CI job failed the setup-guide drift check on every section. JavaScript normalizes line terminators inside template literals, so on a CRLF checkout the text compiled into the binary was LF while the file on disk was CRLF. Line endings are now normalized when the guide is generated — keeping that generated file byte-identical whichever platform runs the script — and when it is compared.

### Changed

- The TUI's MCP page puts the tool list directly under Server, above **Copy agent config**, grouping the things you tune and leaving the copy block at the bottom.

## [0.1.1] - 2026-09-03

### Changed

- `tui.json`'s `cursor`, `scroll_acceleration`, `diff_style`, and `attention` fields are no longer documented or included in the starter file — none of them were ever wired up to anything the TUI reads. Parsing them is unchanged, so a `tui.json` that already sets any of them keeps loading cleanly.

### Fixed

- Configuration merging (root overlays, local overlays, modular per-service files, and template inheritance) now checks whether a raw YAML key was actually present instead of comparing its decoded value against a zero default, so an explicit `false`, `0`, or `[]` is applied instead of being silently discarded as "not set." Several latent instances of the same bug are fixed alongside it: `proxy.enabled`/`proxy.token_endpoint.enabled`, the four `logs.persistence.*` fields, `auth.refresh_threshold_seconds`, `ui.keymap`, and `secrets.extra_markers`/`extra_patterns` could all be unconditionally overwritten or wiped by an overlay that didn't repeat every sibling field.
- `devctl logs export --output <path>` failed every invocation with "required option '--output <path>' not specified" regardless of what was passed: the parent `logs` command's own (optional) `--output` claimed the value before the `export` subcommand's own (required) copy ever saw it. Both `devctl logs --output <path>` and `devctl logs export --output <path>` now also resolve a relative path against the CLI's own working directory before sending it to the daemon, instead of the daemon's — a long-running background process that can have an unrelated one — matching how the TUI's own `/export` already worked.
- `mcp_start` (`devctl mcp --on` with no `--port`, or any on-demand MCP toggle) now falls back to the saved `mcp_port` preference before the repo-derived default, matching what daemon boot already does; it previously ignored a previously chosen port whenever MCP was started outside the boot path.
- The dotenv family now loads `.env.local` after `.env.development`, so a developer's personal, gitignored `.env.local` correctly outranks a checked-in, team-shared `.env.development` instead of being silently overridden by it.
- A proxy route with `auth.type: none` now ignores any leftover `auth.identity`, matching how the proxy's own request handling already treats "none." A stale identity left over from a template or an earlier config could otherwise make service-account bookkeeping — and, transitively, Google Cloud/ADC preflight checks — require an identity the route will never actually use.
- `--config` pointing directly at a `.devctl` directory now resolves the repository root to its parent correctly on every platform, including Windows, and even when that directory already contains `config.yaml` (the ordinary case) — both a hardcoded `/`-splitting path check and a check-ordering bug previously made this resolve to the `.devctl` directory itself instead.
- `config.yaml`'s `ui.keymap` is now actually applied to the TUI's keybindings, below every `tui.json` layer; it was previously parsed and summarized on the config screen but never affected any real keybinding.
- The TUI's `/clear` command now only clears its own on-screen log view. It previously also cleared the daemon's one shared log buffer, so any other attached client — another TUI session, the CLI, MCP — lost their log history too whenever one client cleared theirs; the `logs_clear` RPC is removed, since nothing else in the codebase used it.
- Copying logs (and exporting them locally, without a daemon attached) now matches every currently active filter — regex search, source, multi-service selection, the since/until window, and the system-logs toggle — instead of an incomplete, separately reconstructed filter that could silently copy or export different lines than what was actually on screen.

### Added

- File credential fallback stores metadata only; the access token stays in the keychain or the session cache.
- Windows process inspect fills cwd and samples WorkingSet/CPU.
- TUI `/until` and `devctl logs --until`.
- Starter config writes a `$schema` comment for yaml-language-server.
- Start-plan identity preflight: missing SA or ADC fails that service only.
- `devctl completion zsh|bash|fish` and hidden `__complete` for live service/profile names.
- CI compile smoke (`bun build --compile` linux-x64) and `windows-latest` test job.
- Homebrew formula at `homebrew/devctl.rb` (`brew install --formula <raw url>`).
- `devctl update` reports the latest GitHub Release and an install hint; it does not overwrite the binary.
- Config screen validate/save buffer (`v` / `/buffer`); invalid YAML is not written.
- Per-service `proxy` route fragments merge into the global proxy at load.
- Shared `withRetry` for token mint and doctor live probes; configuration errors are not retried.
- JSON Schema for `.devctl/config.yaml` (`schema/devctl.config.schema.json`) so editors and agents can complete field names.
- `start_services` / `devctl start` with no names use the given profile, then the active session profile, then the first configured profile. They no longer start every service. With no profiles and no names, start fails closed.
- MCP `get_logs` accepts `since` and returns `next_since` so agents can follow new lines instead of re-pulling the last 200.
- CLI `devctl logs --since <timestamp>`.
- GitHub Actions release workflow: tagged `v*` builds compile Bun binaries for macOS, Linux, and Windows.

### Changed

- Windows attach is documented as a named pipe (`\\.\pipe\devctl-<repoID>`). Unix still uses `devctl.sock`.
- Removed leftover Go `.goreleaser.yaml`.

### Added

- `devctl setup --force` overwrites an existing configuration; without it, setup prints the existing path and writes nothing instead of re-prompting for answers it would discard. `setup` now honors `--config`.
- CI and the release workflow run an end-to-end supervisor smoke test (`start` / `status` / `stop`) against the compiled Linux binary.

### Fixed

- Release (and CI compile smoke) install OpenTUI native packages for every OS/CPU before `bun build --compile`, so Darwin and Windows targets resolve `@opentui/core-<platform>`.
- Compiled-binary installs: the supervisor daemon spawned by `start`/`attach` now starts correctly instead of the compiled executable mistaking its own first CLI argument for a Bun script path. Its bootstrap stderr is captured to a repo-specific log, whose path is reported if it fails to come up.
- A losing concurrent `devctl start` for the same repo could delete a still-live peer's supervisor socket before discovering the lock was already held; the lock is now acquired first.
- A crash- or unhealthy-triggered restart scheduled just before a service was stopped, or right as it failed outright, could still fire afterward and resurrect it; those timers are now cancelled on stop, fail, and shutdown.
- A service that failed its startup health check could be resurrected by the crash-restart handler reacting to the kill `fail()` itself performed.
- A health check whose command failed to spawn, or whose plugin check rejected, could crash the check loop instead of reporting unhealthy.
- Proxy: the client's `Host` header no longer leaks to the upstream request; responses compressed with an encoding devctl negotiated (gzip, deflate, br) are decompressed correctly instead of the client receiving a body that no longer matches the forwarded `Content-Encoding`/`Content-Length`. `X-Forwarded-For/Host/Proto` are now set.
- The TUI config buffer's validate/save path now runs unsaved edits through the real modular/overlay/template pipeline instead of a simplified reimplementation that could pass or fail differently than an actual save.
- The TUI's "no configuration found" setup prompt no longer offers to run setup — silently overwriting the file — when the real problem is an existing-but-invalid configuration; it shows the real error instead.
- Quitting a locally-run (non-daemon) session with detach now reliably persists the running services' state before exiting, so they're adoptable by a later `devctl start`/`status`, and the process exits promptly instead of hanging on the detached services' inherited log pipes.

### Added

- Client/daemon handshake: `ping` reports `{session, version, protocol}`; an incompatible daemon blocks ordinary RPCs (except `logs`) with a hint to run `devctl down` and start again.
- `config_snapshot` RPC returns the daemon's real in-memory configuration (local RPC only; never exposed through MCP).
- Daemon discovery falls back to a state-directory scan when `.devctl` has been deleted but a daemon is still running, so a deleted config directory can no longer orphan a live daemon. `devctl status --repo <path>` targets a repository directly, even without a loadable configuration there.
- `devctl down` (and `devctl down --keep-services`) stops the daemon, and by default its services; `--keep-services` stops only the daemon.
- MCP now boots from the saved `mcp_enabled`/`mcp_port` preference at daemon startup itself, regardless of whether the daemon was spawned by the CLI or the TUI.
- `start`/`restart` forward the calling CLI/TUI's own environment to the daemon as `client_env`. The daemon remembers it per service, in memory, so a later crash- or health-triggered restart reuses it instead of the daemon's own environment (which is otherwise a stale snapshot fixed at whenever the daemon was first spawned).

### Changed

- The proxy no longer binds at daemon startup. The first `start()` binds it if enabled; an explicit `proxy stop` suppresses that auto-start (sticky across further starts) until an explicit `proxy start`.
- `devctl start --detach` is deprecated: the daemon already outlives the command regardless of the flag, so passing it now only prints a deprecation warning. Docs point to plain `devctl start` and `devctl down` instead.
- The TUI no longer runs an in-process supervisor as a fallback. It always locates and attaches to a real daemon first, spawning a fresh one only when none is reachable, and its effective configuration is always the attached daemon's `config_snapshot` — refetched on `ConfigurationChanged`. A failed reload shows a persistent banner under the nav bar instead of a transient status line.

### Fixed

- `devctl status` and `devctl down` silently ignored the global `--config` flag (only `--repo` worked); both now honor `--config` the same as every other command.
- The TUI could fail to open at all when the on-disk configuration was invalid or deleted, even with a live daemon still attachable. It now attaches independent of local configuration validity, falling back to local parsing — to spawn a daemon, open setup, or report a real error — only when no daemon is reachable.
- `Bun.spawn()`'s default environment is a snapshot of this process's own `process.env` taken at its own launch, not a live view of it; the supervisor spawned for `start`/`attach` now receives the caller's live environment explicitly, so runtime env changes (e.g. Google Cloud metadata-server detection overrides) reach it correctly.

### Added

- `restart --cascade` (and MCP `restart_services`' `cascade` argument) also restarts a service's transitive dependents; a plain restart touches only the service named.
- Reload reconciles running services against the new configuration: a newly added service appears immediately as stopped; an already-stopped removed service is forgotten; a still-running removed service is marked orphaned — stoppable by name, but no longer restartable or reachable by a cascade. A reload referencing a health or identity plugin type nothing provides is rejected outright, the same as an unparseable config file.
- `Runtime` reports non-secret per-service launch context: `profile`, `env_source` (`client` or `daemon`), and `orphaned`.
- Identity status gains `service_account_status` (`unknown` / `available` / `unavailable`) per configured service account, alongside the existing boolean compatibility map (which now omits identities nothing has probed yet, rather than defaulting them to unavailable).

### Changed

- **Breaking:** `devctl stop x` (and a cascading `restart x --cascade`) now stops `x` and its transitive **dependents** — never its dependencies, which other running services may still need. Previously it stopped `x`'s dependencies instead, which was backwards.
- Service-account probing is lazy and cached, not automatic: a real token fetch per configured identity now only happens on first use (a service actually starting under it), an explicit `auth_refresh`, or a doctor inspection — never on the daemon's own boot or after a reload, which only ever refresh ADC/user/project metadata.

### Fixed

- A slow health check still in flight when its service crashed and restarted under a new pid could land on and corrupt the newer process's state instead of being recognized as stale.
- A port-assignment conflict discovered while assigning a later service in the list could mark an unrelated, earlier-pending service failed instead of the service the conflict actually named.
- A service's restart count stayed maxed out across a manual stop/start (or the stop/start half of a client-requested restart), so the very next crash could fail it outright instead of getting a fresh retry budget; it now also resets after the service has run healthily for long enough. An automatic, health-triggered restart still preserves the count across its own stop/start cycle, so `max_retries` remains an actual limit.
- Supervisor state was persisted only once, at the very end of a whole start or stop plan: an earlier wave's successfully spawned processes, and a crash-restart's respawn (which never goes through the batched path at all), could be lost to a daemon crash instead of being adoptable on the next boot. State is now persisted right after each spawn, adoption, exit, and failure.
- Adopting an already-listening service via its configured port stamped its start time as "now" instead of the real, already-verified persisted start time, understating its uptime and poisoning the record a future adoption would check identity against.
- Starting a different service under a different profile could silently change what environment an unrelated, already-running service's next crash-restart resolved with, since both read the same daemon-wide fallback; each service now keeps its own last-used profile and environment.
- An adopted process's command-type health check ran with a completely empty environment, unable to even resolve `PATH` to find its own executable; it's now reconstructed from the same configured, reproducible sources (profile, dotenv, defaults/vars, secrets, runtime) a fresh start would use.
- An unhandled error on an accepted RPC client socket (an abrupt disconnect — killed, crashed, a network blip) crashed the whole daemon; it's now logged and handled like an ordinary disconnect.

### Added

- `devctl logs -f`, `devctl status --watch`, and `devctl daemon logs [-f]` follow their output live from the terminal until interrupted.
- Log queries are cursor-paginated instead of unbounded: a page defaults to the latest 500 matching events (maximum 5,000), identified by an opaque cursor that supports paging both backward (older) and forward (newer); `since`/`until` timestamp filters keep working alongside it. CLI, TUI, and MCP's `get_logs` all use it.
- Server-side log facets: total matching events, plus per-service/level/source counts (each under every other active filter but its own), via a new lightweight stats-only query. The TUI refreshes them live every two seconds while its logs screen is open, and immediately after a filter change, a clear, or reconnecting.
- The detached supervisor's bootstrap log keeps a short rotated history (the 5 most recent boot attempts) instead of each new attempt silently overwriting the last one's stderr.

### Changed

- The TUI's logs screen fetches a bounded page instead of the entire matching log history on every filter change, and only fetches further back into history as you actually scroll there; live-streamed events keep arriving incrementally on top, with no duplicate or dropped events among ones sharing the same millisecond.
- MCP `get_logs` follows by an opaque `cursor`/`next_cursor` instead of `since`/`next_since`; a plain timestamp cursor could duplicate or drop whichever of several same-millisecond events landed on the wrong side of a page boundary, which a sequence-based cursor cannot. `since`/`until` are now plain inclusive filters for a fresh query rather than doubling as a follow mechanism. The response also gains `has_more` (more events are already waiting — fetch again immediately rather than waiting out the poll interval) and `session_changed` (the daemon restarted since the given cursor was issued, so the latest page was returned instead).

### Fixed

- `devctl status --watch` and `devctl logs -f` no longer crash (and could hang indefinitely retrying the same failing write) when their output is piped into something that closes early, like `| head`, or a terminal that goes away mid-stream — writing to a closed stdout now ends that command quietly instead.

## [0.1.0] - 2026-08-30

### Added

- TypeScript / Bun application: supervisor, TUI, CLI, and localhost MCP on one session.
- Demo platform (`examples/demo-platform`) that runs without Google Cloud.

[Unreleased]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amr-m-abdelgawad/devctl/releases/tag/v0.1.0
