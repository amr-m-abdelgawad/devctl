# Internals — contributor guide

This directory is the **source map for people who change `devctl` itself**. It is not the product manual. Users of the CLI, TUI, MCP, or YAML config should start at [docs/README.md](../README.md).

The user wiki and MCP `search_docs` / `get_doc` tools only index the top-level pages under `docs/`. These internals pages live next to that documentation so they stay in the repo and on the VitePress site, without mixing into the operator wiki.

`docs/architecture.md` is the short layer map CI enforces. `docs/devctl-architecture.md` is a **historical** product spec (Manager names, a `cmd/` tree that does not exist). Read this guide instead of that spec when you need to know what the TypeScript tree actually does.

This file is the docs-site index (`/internals/`). GitHub’s folder view uses [README.md](README.md) — keep the two in sync if you edit the hub.

## What this guide is

A file-by-file orientation of the repository: how two processes talk, which layer owns which decision, how a keystroke or `devctl start` becomes a spawned process, and how to add a feature without violating hexagonal rules.

It does not re-teach YAML for services, IAP audiences, or TUI keybinds. Those remain in the user pages. When an internals page needs product context, it links out.

## Read in this order

New contributors should follow this path once. After that, jump by subsystem.

| Step | Page | Why |
|------|------|-----|
| 1 | [How to read the code](reading-the-code.md) | Mental model, first files to open, how to chase a behavior |
| 2 | [Repository map](repo-map.md) | Every top-level directory and what it is not |
| 3 | [Process model](process-model.md) | Client vs supervisor, lock, socket, attach vs spawn |
| 4 | [Layers](layers.md) | Import rules, composition roots, what CI actually checks |
| 5 | [Bootstrap](bootstrap.md) | `bin.ts` → `createClient` / `createDaemon` |
| 6 | [RPC](rpc.md) | Line-delimited JSON, methods, auth token, events |
| 7 | [Domain](domain.md) | Types and policies with no I/O |
| 8 | [Application](application.md) | Commands, orchestrator, health monitor |
| 9 | [Ports](ports.md) | Every replaceable boundary |
| 10 | [Adapters](adapters.md) | Daemon, config, process, Google, proxy, storage |
| 11 | [Presentation](presentation.md) | CLI, TUI, MCP, loopback web UI |
| 12 | [Config pipeline](config-pipeline.md) | Discover → decode → merge → validate → snapshot |
| 13 | [Runtime](runtime.md) | Start/stop waves, processes, containers, reload |
| 14 | [Identity and proxy](identity-proxy.md) | Tokens, impersonation, IAP, HTTP recipes |
| 15 | [Logs, telemetry, LLM](logs-telemetry.md) | Ring buffer, worker, OTLP, LiteLLM |
| 16 | [Events and errors](events-errors.md) | Bus facts vs command calls; exit codes |
| 17 | [Testing and CI](testing-ci.md) | `bun test`, architecture, coverage, hygiene |
| 18 | [Packaging](packaging.md) | Compiled binary, npm launcher, Homebrew, docs site |
| 19 | [Adding a feature](adding-features.md) | Checklists for RPC, CLI, TUI, MCP, config fields |

## Hard rules that show up everywhere

1. **Nothing in the application hard-codes a service name, port, or service account.** Those come from `.devctl/` after load.
2. **Presentation never starts or kills processes.** CLI, TUI, MCP, and the web UI call application commands or the `Controller`. `ProcessRuntime` lives in adapters.
3. **Commands are calls. Events are facts that already happened.** Do not drive start/stop through `Bus`.
4. **Google Cloud is an adapter.** Local-only configs must run with no ADC.
5. **One composition root per process:** `bootstrap/client.ts` and `bootstrap/daemon.ts`. No DI container.

Day-to-day commands: [CONTRIBUTING.md](../../CONTRIBUTING.md). Layer checker: [architecture.md](../architecture.md).
