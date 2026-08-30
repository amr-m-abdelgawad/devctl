# devctl wiki

`devctl` is a configuration-driven local development orchestrator. It starts and stops services, resolves environment, optional Google identity, an auth-aware proxy, health checks, and centralized logs — from a keyboard-first TUI, a CLI, or an optional MCP server for coding agents.

The running product is TypeScript on [Bun](https://bun.sh) with an [OpenTUI](https://opentui.com/docs/) interface. There is no Go binary.

## Start here

| Page | What you get |
|------|----------------|
| [How it fits together](overview.md) | Supervisor, TUI, CLI, MCP, and what lives on disk |
| [Installation](installation.md) | Bun, `bun link`, optional `gcloud` |
| [Quick start](quickstart.md) | First session: setup → doctor → TUI |
| [Developer setup](developer-setup.md) | Day-to-day loop without admin privileges |
| [Demo platform](../examples/demo-platform/README.md) | Local invoicing example (no Google Cloud) |

## Using it

| Page | Side |
|------|------|
| [TUI](tui.md) | Screens, keys, slash commands, themes, settings |
| [CLI](cli.md) | Commands, flags, exit codes, attach vs start |
| [MCP](mcp.md) | Localhost Streamable HTTP for Claude, Cursor, Codex, Kilo |
| [Logs](logs.md) | Buffer, filters, export, history |
| [Doctor](doctor.md) | Environment and Google diagnostics |
| [Troubleshooting](troubleshooting.md) | Symptom → fix |

## Configuration

| Page | Side |
|------|------|
| [Configuration](configuration.md) | Discovery, merge, validation, reload |
| [Services](services.md) | Commands, ports, health, restart, dependencies |
| [Profiles](profiles.md) | Named sets, session recovery |
| [Environment](environment.md) | Source order, `${…}` refs, secrets |

## Identity and proxy

| Page | Side |
|------|------|
| [Authentication](authentication.md) | ADC, project source, `devctl auth` |
| [Impersonation](impersonation.md) | Service-account tokens without keys |
| [IAP](iap.md) | Audience, user vs SA identity tokens |
| [Proxy](proxy.md) | Loopback routes, token endpoint |
| [Admin setup](admin-setup.md) | IAM and APIs administrators own |
| [Security](security.md) | Redaction, bind rules, credential files |

## Reference

| Page | Side |
|------|------|
| [Building from source](typescript.md) | `ts/` layout, tests, TUI config file |
| [Architecture spec](devctl-architecture.md) | Original implementation specification (historical). Do not treat the `cmd/` tree there as the current repo. |
| [License](../LICENSE) | MIT |

Configuration never hard-codes service names, ports, or service accounts. Those belong in `.devctl/`.
