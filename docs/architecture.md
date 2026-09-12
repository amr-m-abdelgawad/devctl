# Architecture

`devctl` is a modular monolith with ports-and-adapters layering. The process model is unchanged: TUI, CLI, and MCP talk to a long-lived supervisor over a local socket. This page is the living layer map. The older Manager-centric sketch in [devctl-architecture.md](devctl-architecture.md) §3–4 is historical.

## Layers

```text
app/src/
  presentation/    cli, tui, mcp, web
  application/     commands, queries, orchestrator
  domain/          service, identity, health, config types
  ports/           ProcessRuntime, Clock, FileSystem, HealthChecker, …
  adapters/        daemon, rpc, doctor, environment, plugins, net, secrets, system,
                   process, google, config, health, proxy, storage, containers
  shared/          events, errors, retry, warnings
  bootstrap/       one composition root per process
```

Dependency direction points inward:

```text
presentation  → application, ports, shared, domain types
application   → domain, ports, shared
domain        → shared (and other domain)
ports         → domain, shared
adapters      → ports, domain, shared
bootstrap     → everything
test          → any layer
```

Forbidden: domain → adapters/application/presentation; application → adapters/presentation; adapters → presentation/application.

## Composition roots

There is exactly one composition root **per process**:

- `bootstrap/daemon.ts` — supervisor, orchestrator, adapters, MCP, proxy, web UI
- `bootstrap/client.ts` — CLI/TUI, Controller, offline commands

No DI container. Constructor injection only. Bootstrap is allowed to be ugly.

## Commands vs events

Commands are explicit calls (`StartService.execute`). Events on `Bus` are facts that already happened (`ServiceStarted`). Do not drive orchestration through the event bus.

## Enforcement

```bash
cd app && bun run check:architecture
```

CI runs the same script. Domain, application, and ports must not import `google-auth-library` or `@opentui/*`.
Presentation may import presentation, application, ports, shared, and domain modules.
Adapters cannot import presentation, application, or leftover root modules.
`*.test.ts` files are a `test` layer and may compose any layer, including
bootstrap fixtures. The production allowlist is empty: a new forbidden pair
fails, and a stale exception for a removed import also fails.

The checker parses TypeScript syntax, including type imports, re-exports, literal
dynamic imports, and `require()` calls. Comments and example strings do not count
as dependencies.

## Related

- [How it fits together](overview.md)
- [Building from source](typescript.md)
- Agent rules: `.cursor/rules/architecture.mdc`


## Migration progress

The service launch and health extraction is complete. `application/orchestrator.ts`
owns launch sequencing, hooks, health waits, and stop/restart plans.
`application/health-monitor.ts` owns health probes, lifecycle generations, restart
timers, and the shared crash/unhealthy retry budget. Process/container launch and
transient commands use `ProcessRuntime`; health probes use `HealthCheckerFactory`.
Supervisor coordinates service lifecycles. RPC accept, line framing, and dispatch
routing live in `adapters/rpc/server.ts` (paired with the existing controller
client). Identity cache, credential entries, and service-account probes live in
`adapters/daemon/identity-coordinator.ts`. Client/profile environment resolution
lives in `adapters/daemon/environment-bridge.ts`. Proxy and token-endpoint bind
live in `adapters/daemon/proxy-coordinator.ts`. MCP listen and the tool deny-list
live in `adapters/daemon/mcp-coordinator.ts`. Host CPU/memory sampling lives in
`adapters/daemon/resource-sampler.ts`. Supervisor still owns persistence,
adoption, config watch, and the host facades that bind those slices.
Its public start/stop/restart methods continue to delegate to the application.

The legacy daemon, controller, doctor, environment, plugin registry, network-port,
secret-detector, and host-stat modules and their tests now live under `adapters/`.
The setup command and its tests live under `presentation/cli/`. `plugin-sdk.ts`
and `bin.ts` retain their public paths. Daemon command and MCP composition live
in `bootstrap/daemon.ts` and `bootstrap/test-supervisor.ts`, so adapters do not
import application or presentation. Integration tests compose through those
fixtures rather than architecture exceptions.

The stricter layer rules and doctor boundary are in place. `RunDoctor` depends on
`ports/doctor-runner.ts`; the adapter implements it with the existing diagnostics.
Doctor reports, progress, runtime context, and port-holder data live in `domain/`,
so application code and doctor screens do not import adapter types for these values.
Production CLI, TUI, and MCP modules now have no adapter or bootstrap import
exceptions. `bin.ts` supplies the client runtime and daemon launcher to the CLI;
the TUI workspace receives that same runtime. The application owns the
`ClientRuntime` and `Controller` contracts. Config, Google status, logs, session,
and preference view types live in domain modules. Preference persistence stays
in the config adapter, and MCP validation is supplied by its host. Integration
tests compose through bootstrap fixtures instead of layer exceptions.

The TUI decomposition is complete. `App.tsx` coordinates screen rendering and
state wiring. Hooks under `presentation/tui/hooks/` own log filtering/windowing
and paged queries, daemon event subscriptions, diagnostics, lifecycle commands,
environment inspection, config editing, MCP controls, preferences, command
dispatch, and keyboard/overlay dispatch (`use-app-keyboard.ts`). They receive
the client workspace or controller explicitly. Screen helpers live in focused
modules under `presentation/tui/helpers/`; production consumers import those
modules directly. The old `helpers.ts` is a compatibility barrel, also
exercised by the existing helper tests.

Hook regression tests cover stale diagnostic and environment results, pinned log
windows, failed lifecycle commands, config validation before writes, preference
preview/override behavior, and rendering App in setup mode.

The final dependency/ID phase is complete. Supervisor requires its token and
process runtimes, clock, filesystem, event bus, Google detector, health-checker
factory, orchestrator, log store, secret detector, session id, process
inspect/alive helpers, lock/socket functions, and an MCP listener factory.
`createDaemon` selects production defaults, shares the injected clock and bus,
builds `commandsForHost`, and attaches commands after construct. The explicit
test fixture mirrors that wiring. Supervisor does not import application or
presentation modules; it talks to `DaemonCommands`, `LifecycleSession`,
`McpHost`, and `McpListener` ports.

`StartProfile`, `ResolveStart`, and domain profile resolution use `ProfileId`.
Transport and UI entry points convert strings before calling those boundaries;
RPC/JSON fields stay strings. `ProcessManager implements ProcessRuntime` and
health-checker injection remain in place. Snapshot and RPC payload types live
in `domain/status.ts`; `types.ts` is the shared `Envelope` only. All six
phases in the remaining-work plan are complete. The follow-up leftover work
emptied the architecture allowlist: tests are a first-class layer, daemon
composition lives in bootstrap, and there are no production import exceptions.

Keep RPC names, JSON fields, `plugin-sdk.ts`, and `bin.ts` stable. Validate each
phase with `bun test`, `./node_modules/.bin/tsc --noEmit`,
`bun run check:architecture`, `bun run check:coverage`, `bun run check:dead`, and `bun run check:dup`
from `app/`.
