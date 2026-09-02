# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.1.0] - 2026-08-30

### Added

- TypeScript / Bun application: supervisor, TUI, CLI, and localhost MCP on one session.
- Demo platform (`examples/demo-platform`) that runs without Google Cloud.

[Unreleased]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amr-m-abdelgawad/devctl/releases/tag/v0.1.0
