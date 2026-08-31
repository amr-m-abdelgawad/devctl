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

### Fixed

- Release (and CI compile smoke) install OpenTUI native packages for every OS/CPU before `bun build --compile`, so Darwin and Windows targets resolve `@opentui/core-<platform>`.

## [0.1.0] - 2026-08-30

### Added

- TypeScript / Bun application: supervisor, TUI, CLI, and localhost MCP on one session.
- Demo platform (`examples/demo-platform`) that runs without Google Cloud.

[Unreleased]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amr-m-abdelgawad/devctl/releases/tag/v0.1.0
