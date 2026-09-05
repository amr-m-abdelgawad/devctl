# Architecture

`devctl` is a modular monolith with ports-and-adapters layering. The process model is unchanged: TUI, CLI, and MCP talk to a long-lived supervisor over a local socket. This page is the living layer map. The older Manager-centric sketch in [devctl-architecture.md](devctl-architecture.md) §3–4 is historical.

## Layers

```text
app/src/
  presentation/    cli, tui, mcp
  application/     commands, queries, orchestrator
  domain/          service, identity, health, config types
  ports/           ProcessRuntime, Clock, FileSystem, HealthChecker, …
  adapters/        daemon, rpc, doctor, environment, plugins, net, secrets, system,
                   process, google, config, health, proxy, storage, containers
  shared/          events, errors
  bootstrap/       one composition root per process
```

Dependency direction points inward:

```text
presentation  → application, shared, domain types
application   → domain, ports, shared
domain        → shared (and other domain)
ports         → domain, shared
adapters      → ports, domain, shared
bootstrap     → everything
```

Forbidden: domain → adapters/application/presentation; application → adapters/presentation; adapters → presentation/application.

## Composition roots

There is exactly one composition root **per process**:

- `bootstrap/daemon.ts` — supervisor, orchestrator, adapters, MCP, proxy
- `bootstrap/client.ts` — CLI/TUI, Controller, offline commands

No DI container. Constructor injection only. Bootstrap is allowed to be ugly.

## Commands vs events

Commands are explicit calls (`StartService.execute`). Events on `Bus` are facts that already happened (`ServiceStarted`). Do not drive orchestration through the event bus.

## Enforcement

```bash
cd app && bun run check:architecture
```

CI runs the same script. Domain, application, and ports must not import `google-auth-library` or `@opentui/*`.
Presentation may import only presentation, application, shared, and domain modules;
adapters may no longer import legacy root modules. Remaining migration exceptions
are exact source/target pairs in the check script. New forbidden pairs fail, and
an exception left behind after its dependency is removed also fails.

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
Supervisor retains the temporary identity/environment bridge, persistence, adoption,
RPC, config watch, proxy, and MCP hosting. Its public start/stop/restart methods
continue to delegate to the application.

The legacy daemon, controller, doctor, environment, plugin registry, network-port,
secret-detector, and host-stat modules and their tests now live under `adapters/`.
The setup command and its tests live under `presentation/cli/`. `plugin-sdk.ts`
and `bin.ts` retain their public paths. Existing daemon composition imports are
recorded as exact temporary exceptions in the architecture check, alongside
exceptions for integration-test composition; no layer-wide permissions were added.

The stricter layer rules and doctor boundary are in place. `RunDoctor` depends on
`ports/doctor-runner.ts`; the adapter implements it with the existing diagnostics.
Doctor reports, progress, runtime context, and port-holder data live in `domain/`,
so application code and doctor screens do not import adapter types for these values.
The presentation migration still has explicit exceptions to remove in the next phase.

Remaining migration phases, in order:

1. Inject the client runtime into CLI/TUI and move remaining screen types inward.
2. Split TUI App/helpers by responsibility.
3. Require all Supervisor dependencies and apply `ProfileId` at profile boundaries.
   Health-checker injection and `ProcessManager implements ProcessRuntime` are already in place.

Keep RPC names, JSON fields, `plugin-sdk.ts`, and `bin.ts` stable. Validate each
phase with `bun test`, `./node_modules/.bin/tsc --noEmit`, and
`bun run check:architecture` from `app/`.
