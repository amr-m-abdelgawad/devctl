# Security policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue.

Use [GitHub Security Advisories](https://github.com/amr-m-abdelgawad/devctl/security/advisories/new) for this repository.

Include the affected version (`devctl version`), what you expected, and a minimal reproduction. We will acknowledge the report and work on a fix before any public disclosure.

## Product guarantees

`devctl` is a localhost orchestrator. Tokens stay out of the TUI, logs, and MCP output. The proxy, token endpoint, and MCP bind `127.0.0.1` only. Service-account keys are never created.

The full model is in [docs/security.md](docs/security.md).
