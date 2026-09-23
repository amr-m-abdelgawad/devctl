# devctl wiki

`devctl` is a configuration-driven local development orchestrator. It starts and stops services, resolves environment, optional Google identity, an auth-aware proxy, health checks, and centralized logs — from a keyboard-first TUI, a CLI, an optional MCP server for coding agents, or an opt-in loopback web console.

The running product is TypeScript on [Bun](https://bun.sh) with an [OpenTUI](https://opentui.com/docs/) interface. There is no Go binary.

## Start here

| Page | What you get |
|------|----------------|
| [How it fits together](overview.md) | Supervisor, TUI, CLI, MCP, and what lives on disk |
| [Installation](installation.md) | npm, release binaries, source install, optional `gcloud` |
| [Quick start](quickstart.md) | First session: setup → doctor → TUI |
| [Onboard your repository](onboarding.md) | Inventory, configure, validate, and verify your own stack |
| [Examples & recipes](examples.md) | Frontend, workers, containers, proxy, and tracing workflows |
| [Developer setup](developer-setup.md) | Day-to-day loop without admin privileges |
| [Demo platform](../examples/demo-platform/README.md) | Local invoicing example (no Google Cloud; opt-in Docker `data` profile) |
| [Agent skills](../skills/README.md) | Onboard a repo, or debug a service devctl is already running |

## Using it

| Page | Side |
|------|------|
| [Web console](web.md) | Browser controls, dependency graph, logs, traces, LLM, traffic, doctor, identity |
| [TUI](tui.md) | Screens, keys, slash commands, themes, settings |
| [CLI](cli.md) | Commands, flags, exit codes, attach vs start |
| [MCP](mcp.md) | Localhost Streamable HTTP for Claude, Cursor, Codex, Kilo |
| [Logs](logs.md) | Buffer, filters, export, history |
| [LLM inspector](llm.md) | LiteLLM spend logs and proxy-capture sources in MCP, web, TUI, CLI |
| [Proxy](proxy.md) | Auth-aware reverse proxy, expose, and optional body inspect |
| [Telemetry](telemetry.md) | OTLP receiver, traces, and the opt-in loopback [web console](telemetry.md#web-ui) |
| [Doctor](doctor.md) | Environment and Google diagnostics |
| [Troubleshooting](troubleshooting.md) | Symptom → fix |

## Configuration

| Page | Side |
|------|------|
| [Configuration](configuration.md) | Discovery, merge, validation, JSON Schema, reload |
| [Services](services.md) | Commands, ports, health, restart, dependencies |
| [Profiles](profiles.md) | Named sets, session recovery |
| [Environment](environment.md) | Source order, `${…}` refs, secrets |
| [Custom HTTP APIs](http.md) | Named outbound recipes, token cache, local expose |
| [Plugins](plugins.md) | SDK contract, extension points, generic OIDC provider |

## Identity and proxy

| Page | Side |
|------|------|
| [Authentication](authentication.md) | ADC, project source, `devctl auth` |
| [Impersonation](impersonation.md) | Service-account tokens without keys |
| [IAP](iap.md) | Audience, user vs SA identity tokens |
| [Proxy](proxy.md) | Loopback routes, token endpoint, recipe expose, body inspect |
| [Admin setup](admin-setup.md) | IAM and APIs administrators own |
| [Security](security.md) | Redaction, bind rules, credential files |

## Contribute to this repository

These pages are **not** the operator manual. They map the TypeScript tree for people changing `devctl` itself.

| Page | Side |
|------|------|
| [Internals (contributor guide)](internals/index.md) | How to read the repo, every layer, RPC, adding features |
| [Contributing](../CONTRIBUTING.md) | Source loop, tests, and where to edit docs |

## Reference

| Page | Side |
|------|------|
| [Building from source](typescript.md) | `app/` layout, tests, TUI config file |
| [Architecture](architecture.md) | Layers, composition roots, import rules |
| [Platform bets](platform-bets.md) | Remote/multi-repo/k8s/OIDC/signing — design separately |
| [npm publishing](npm-publishing.md) | Maintainer bootstrap, trusted publishing, and release trust |
| [Changelog](../CHANGELOG.md) | Notable changes, newest first |
| [License](../LICENSE) | MIT |
| [Security policy](../SECURITY.md) | How to report a vulnerability |

Configuration never hard-codes service names, ports, or service accounts. Those belong in `.devctl/`.
