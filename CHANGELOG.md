# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amr-m-abdelgawad/devctl/releases/tag/v0.1.0
