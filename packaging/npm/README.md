# @amr-m-abdelgawad/devctl

One terminal for your local stack. Start services, watch logs, check identity, and drive the proxy from a keyboard-first TUI, the CLI, or an agent over MCP.

## Try it

Node.js 18 or later is the only prerequisite. The package installs its own official Bun runtime.

```bash
npx @amr-m-abdelgawad/devctl@latest
```

## Install it

For regular use, install the command globally:

```bash
npm install --global @amr-m-abdelgawad/devctl
devctl version
```

Then, from a repository:

```bash
devctl setup
devctl doctor
devctl
```

Google Cloud CLI is optional and is needed only for user identity, service-account impersonation, or IAP.

Documentation and source: [github.com/amr-m-abdelgawad/devctl](https://github.com/amr-m-abdelgawad/devctl)

## Platform support

- macOS: Apple silicon and Intel
- Linux: arm64 and x64, including glibc and musl distributions
- Windows: x64

This free npm distribution runs devctl's JavaScript with Bun's official runtime. It does not claim that the optional standalone GitHub binaries are signed by Apple or Microsoft.
