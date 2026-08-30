# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- JSON Schema for `.devctl/config.yaml` (`schema/devctl.config.schema.json`) so editors and agents can complete field names.
- `start_services` / `devctl start` with no names use the given profile, then the active session profile, then the first configured profile. They no longer start every service. With no profiles and no names, start fails closed.
- MCP `get_logs` accepts `since` and returns `next_since` so agents can follow new lines instead of re-pulling the last 200.
- CLI `devctl logs --since <timestamp>`.
- GitHub Actions release workflow: tagged `v*` builds compile Bun binaries for macOS, Linux, and Windows.

### Changed

- Windows attach is documented as a named pipe (`\\.\pipe\devctl-<repoID>`). Unix still uses `devctl.sock`.
- Removed leftover Go `.goreleaser.yaml`.

## [0.1.0] - 2026-08-30

### Added

- TypeScript / Bun application: supervisor, TUI, CLI, and localhost MCP on one session.
- Demo platform (`examples/demo-platform`) that runs without Google Cloud.

[Unreleased]: https://github.com/amr-m-abdelgawad/devctl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amr-m-abdelgawad/devctl/releases/tag/v0.1.0
