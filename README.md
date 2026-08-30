# devctl

A configuration-driven local development orchestrator: services, dependencies, environment, Google identity, service-account impersonation, IAP, an authentication-aware proxy, health checks, centralized logs, a keyboard-first TUI, and an optional MCP server for coding agents.

```bash
git clone …
cd project
devctl setup
devctl
```

## Install

Requires [Bun](https://bun.sh).

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd ts
bun install
bun run src/bin.ts --help
```

Link the CLI onto your PATH if you want `devctl` as a command:

```bash
cd ts && bun link
```

From the repository root you can also run `bun run ts/src/bin.ts`.

## Quick start

1. Add `.devctl/config.yaml` (or run `devctl setup`).
2. Authenticate if any service needs Google Cloud: `gcloud auth application-default login`
3. Validate: `devctl config validate` and `devctl doctor`
4. Start the TUI: `devctl`  
   or start in the background: `devctl start --profile backend --detach`

The TUI is [OpenTUI](https://opentui.com/docs/). Preferences: `tui.json`, `DEVCTL_TUI_CONFIG`.

Wiki: [docs/](docs/README.md) — how the supervisor, TUI, CLI, and MCP fit together, plus configuration, identity, proxy, logs, and troubleshooting.

Try the local demo (no Google Cloud): [examples/demo-platform](examples/demo-platform/README.md).

## Design rules

- No hard-coded services, ports, profiles, environment variables, or service accounts
- User identity and service identity are never silently swapped
- Tokens and secrets are redacted in the TUI, logs, and MCP output
- The proxy, token endpoint, and MCP server bind to `127.0.0.1` only
- Purely local services work without Google Cloud
