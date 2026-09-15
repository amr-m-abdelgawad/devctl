# Adding a feature

Work from the command path, not from a UI overlay. Keep hexagonal imports green.

## 0. Before you write code

- Name the **use case** (a verb: start proxy, page logs, validate buffer).
- Decide which **process** owns it: client-only (`ClientRuntime`) vs daemon (`Supervisor` / orchestrator / coordinator).
- Decide whether it is a **command** (does something) or an **event** (already happened).

## New daemon capability (typical)

Example: a new RPC the TUI and CLI should both expose.

1. **Domain** — types in `domain/` or `domain/status.ts` if they cross the wire.
2. **Port** — only if you need a fake or a second implementation.
3. **Adapter** — coordinator or existing module under `adapters/`.
4. **Command** — `execute` in `application/commands.ts` + `commandsForHost` if it is a mutation other faces share.
5. **RPC** — `Supervisor.dispatch` case + `Controller` method + `params.ts` if parsing is non-trivial. Bump `RPC_PROTOCOL_VERSION` if old daemons would mis-parse (otherwise document backward compatible defaults).
6. **CLI** — `presentation/cli/*` using `ClientRuntime` / `Controller` only.
7. **TUI** — hook + screen (or a small overlay if it is truly modal). Keys in `keymap.ts` / `commands.ts`.
8. **MCP** — `MCP_TOOLS` entry in `tools.ts` + `callMcpTool`. Mark `mutates: true` when it changes state. Default-off if dangerous (`exec_service` pattern).
9. **Web** — only if the SPA should do it; reuse tool functions, do not fork logic.
10. **Tests** — command/orchestrator unit tests; one RPC or CLI test; architecture still empty allowlist.
11. **User docs** — `docs/*.md` + VitePress sidebar + wiki sidebar + `bun run sync-guide`.
12. **Changelog** — user-visible behavior.

## New CLI-only command (no daemon)

Add a function to `ClientRuntime`, implement in `createClient`, call it from `presentation/cli`. Examples: `config validate`, `setup`, `doctor` (doctor *can* use runtime context in the TUI, but the CLI loads YAML locally).

## New config field

Follow [config pipeline](config-pipeline.md): `types.ts` → decode/merge/known/schema → validate → tests → `schema-parity.test.ts` → user `docs/configuration.md` or the relevant page → authoring.md if the loader rejects something the schema cannot express.

Never hard-code a service name, port, or SA email. Put it in YAML.

## New health / identity / env / LLM / log parser type

That is a **plugin extension point** (`adapters/plugins/registry.ts` + `plugin-sdk.ts`). Built-ins stay in their adapter package and register through the same factory pattern (`healthCheckerFactory`, `llmSourceFactory`). Config `type:` strings are validated **after** plugins load.

An `LlmSourceDriver` may set `mode: "push"` (like the builtin `proxy` source): the coordinator then registers no poll timer and the driver is fed out-of-band instead — see the capture path in [logs-telemetry](logs-telemetry.md).

## New TUI screen

1. Add a `Screen` union member in `types.ts`.
2. Render branch in `App.tsx`.
3. Nav + keymap in `helpers/navigation.ts` / `keyboard-screens.ts`.
4. Data from hooks (`use-daemon-events` snapshot or a dedicated hook that calls `Controller`).
5. Keep the screen component mostly JSX; put filtering in helpers.

Do not start processes from a screen. Do not import adapters.

## New coordinator inside the daemon

If `supervisor.ts` grows another independent listener or poll loop, extract `adapters/daemon/<name>-coordinator.ts` with a deps object (`cfg: () => DevctlConfig`, `log`, `persistState`). Wire it in the `Supervisor` constructor. Follow `McpCoordinator` / `ProxyCoordinator`.

Do not create `FooManager` at the repo root.

## Checklist before a PR

```bash
cd app
bun test
bun run check:coverage
bun run typecheck
bun run check:architecture
bun run check:dead
bun run check:dup
```

If you touched docs or skills: `bun run sync-guide`. If you touched `app/web/`: `bun run build:web`. If you touched layers: architecture + knip.

CI must stay green; there is no `--no-verify` path in contributing docs.

## What this repo will reject

- Presentation importing `adapters/config` or `bootstrap`
- Domain importing `google-auth-library` or OpenTUI
- Driving start/stop solely by publishing a bus event
- Binding MCP/proxy/web on `0.0.0.0`
- Logging bearer tokens
- New production architecture allowlist entries
- YAML features that exist only in JSON Schema and not in `decode`/`validate`
