# CLI

The CLI and the TUI share one supervisor. Global flag: `--config <path>` (file or `.devctl` directory).

```text
devctl                         # TUI (may start a local supervisor)
devctl version
devctl start [svc…] [--profile] [--detach] [--json]
devctl stop [svc…] [--json]
devctl restart [svc…] [--json]
devctl status [--json]
devctl logs [svc…] [--level] [--search] [--regex] [--source] [--since] [--until] [--output] [--json]
devctl logs export --output FILE
devctl reload
devctl doctor [--json]
devctl setup [--force]
devctl auth status|login|logout|refresh [--json]
devctl proxy status|start|stop
devctl mcp [--on|--off] [--port N] [--json]
devctl config validate|show [--json]
devctl attach
devctl completion zsh|bash|fish
devctl update [--json]
```

`_supervisor` is an internal command. Do not invoke it by hand.

## Start, stop, status

- `start` with `--profile` starts that profile’s members (plus dependencies).
- `start` with **no** profile and **no** names uses the active session profile, then the first configured profile (alphabetically). With no profiles it errors instead of starting every service.
- `--detach` leaves the supervisor running after the command exits.
- `start` exits **5** when a requested service fails to spawn, **6** when it starts but never becomes healthy.
- `stop` with no names stops every started service.
- `restart` is stop then start; start still expands dependencies.
- `status` with no socket prints persisted per-repo state (or “stopped”) and exits **0**.
- `status` also prints proxy and MCP listen lines when a supervisor is up.

`devctl attach` dials an existing supervisor only. It does not start one. If nothing is listening, it errors with a hint to run `devctl start --detach` first.

## Setup

`devctl setup` honors `--config` (the repo/path to set up, not just the one to read). It never overwrites a configuration that already exists there — it prints the existing path and writes nothing. Pass `--force` to overwrite it instead; without a config on disk yet, setup runs its interactive wizard as usual.

RPC errors include `{ error, kind, hint }` so the CLI maps kinds to the table below.

## Completions

`devctl completion zsh` (or `bash` / `fish`) prints a script that calls `devctl __complete` for live values (profiles, service names, `start` / `stop` / `logs`).

```bash
# zsh — add to ~/.zshrc
source <(devctl completion zsh)

# bash
source <(devctl completion bash)

# fish
devctl completion fish > ~/.config/fish/completions/devctl.fish
```

`__complete` is an internal helper. It loads configuration the same way the CLI does.

## Update

`devctl update` checks the latest GitHub Release and prints the current version, latest tag, and an install hint. It does **not** overwrite the running binary.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | general error |
| 2 | configuration (also `devctl doctor` when any check is not ok) |
| 3 | authentication |
| 4 | authorization |
| 5 | service startup |
| 6 | health check |
| 7 | proxy |

## Related

- [TUI](tui.md)
- [MCP](mcp.md)
- [Logs](logs.md)
- [How it fits together](overview.md)
