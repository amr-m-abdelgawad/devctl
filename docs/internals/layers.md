# Layers

Hexagonal (ports-and-adapters) layering is a **CI gate**, not a style preference. `cd app && bun run check:architecture` walks every `.ts`/`.tsx` file, parses imports with the TypeScript compiler API, and fails on forbidden edges. The production allowlist is empty: a new exception is a new violation, and a stale allowlist entry is also a failure.

The checker lives in `app/scripts/check-architecture.ts`. Tests of the checker itself: `app/src/architecture.test.ts`.

## Dependency direction

```text
presentation  →  application, ports, shared, domain
application   →  domain, ports, shared
ports         →  domain, shared
adapters      →  ports, domain, shared, other adapters
shared        →  shared only
bootstrap     →  everything (the composition root)
test          →  everything (*.test.ts / *.test.tsx)
```

Forbidden in production:

- domain → adapters, application, presentation, Google SDK, OpenTUI
- application → adapters, presentation, Google SDK, OpenTUI
- ports → adapters, presentation, those SDKs
- adapters → presentation, application
- presentation → adapters, bootstrap, leftover root modules (`legacy`)

`node:` and `bun:` specifiers are ignored (they are not layers). Comments and quoted example strings are not imports.

## Layer of a file

```text
*.test.ts / *.test.tsx     → test
domain|application|ports|adapters|presentation|shared|bootstrap/ → that name
bin.ts                     → bootstrap
types.ts, version.ts       → shared
anything else under src/   → legacy  (must not grow)
```

`plugin-sdk.ts` sits at `src/` root. Treat it as a stable public facade; it re-exports adapter/domain types for file plugins.

## Why presentation cannot import adapters

If `presentation/cli/setup.ts` imported `adapters/config/load.ts` directly, every CLI test and the architecture checker would couple UI to filesystem YAML. Instead:

- `ClientRuntime` (application contract) lists `load`, `validate`, `openController`, …
- `bootstrap/client.ts` fills those functions with adapter implementations
- CLI/TUI/MCP receive `ClientRuntime` and never name adapter modules

Doctor is the same pattern: `RunDoctor` depends on `ports/doctor-runner.ts`; `adapters/doctor/doctor.ts` implements it; bootstrap injects it.

## Why adapters cannot import application

`Supervisor` must not construct `StartService` by importing `application/commands.ts`. Bootstrap passes `createCommands: (host) => commandsForHost(host, doctor, orchestrator)`. The supervisor stores `DaemonCommands` (a port-shaped bag of `{ execute }`).

Integration tests that need a real supervisor use `bootstrap/test-supervisor.ts`, which performs that wiring with fake Google by default.

## Ports exist only at replaceable boundaries

Do not add `IService` / `IServiceManager`. A port is justified when at least one of these is true:

- Tests need a fake (clock, filesystem, process runtime, health checkers)
- A second implementation exists or is planned (token providers, log parsers, LLM sources, plugins)
- Presentation/application must not see Google or OpenTUI types

`ports/credential-provider.ts` is reserved for a future split of `TokenManager`; Knip ignores it. Do not invent more unused ports “for symmetry.”

## Commands vs events

| | Commands | Events |
|--|----------|--------|
| Direction | Caller asks for a change | Something already happened |
| Transport | RPC method, `StartService.execute`, MCP tool | `Bus.publish` → socket `{ event }` |
| Examples | `start`, `reload`, `proxy_start` | `ServiceStarted`, `LogReceived`, `ConfigurationChanged` |
| Orchestration | Yes | No |

The TUI subscribes to the bus to **repaint**. It does not start services by waiting for an event.

## Composition roots

Exactly one per process:

- `bootstrap/daemon.ts` — `createDaemon`, `runDaemon`
- `bootstrap/client.ts` — `createClient`

`bin.ts` is also tagged `bootstrap` so it may import both. Keep it tiny.

Constructor injection only. Bootstrap is allowed to look ugly.

## Domain purity

`FORBIDDEN_PACKAGES` for domain, application, and ports:

- `google-auth-library`
- `@opentui/core`
- `@opentui/react`

Identity *policy* (`identityBlockers`, brand types) lives in `domain/identity`. Token HTTP lives in `adapters/google`.

## Practical checklist after a structural change

```bash
cd app
bun run check:architecture
bun run check:dead
bun run check:dup
bunx tsc --noEmit
bun test
```

Adding or removing a module almost always requires the dead-code and clone checks, not only the architecture script.
