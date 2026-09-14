# Presentation

Four faces, one `Controller` / `McpHost`. **None of them spawn user services.**

## CLI — `presentation/cli/`

Commander tree in `cli.ts` `newRoot(runtime, launchDaemon)`.

| Module | Commands |
|--------|----------|
| `lifecycle.ts` | `start`, `stop`, `restart`, `run`, `exec`, `status`, `down`, `attach` |
| `logs.ts` | `logs`, hidden `_supervisor` is **not** here — `addDaemon` is session log helpers; `_supervisor` is `addSupervisor` in `cli.ts` |
| `llm.ts` | `llm` inspector |
| `auth.ts` | `auth login/logout/status/refresh` |
| `listeners.ts` | `proxy`, `mcp` |
| `web.ts` | `web` |
| `config.ts` | `config validate/show/diff`, `reload` |
| `setup.ts` | `setup` wizard (uses `ClientRuntime` + `setup-starter`) |
| `complete.ts` | Shell completion + hidden `__complete` |
| `update.ts` | `update` |
| `shared.ts` | `--config` flag, stdout EPIPE, JSON helpers |

Offline (no daemon required): `setup`, `doctor`, `config validate`, `completion`, `version`. Everything that mutates a session opens a `Controller`.

Exit codes: `shared/errors.ts` `exitCode()` from `DevctlError.kind`. Uncaught errors in `execute` print `humanMessage` and exit.

## TUI — `presentation/tui/`

OpenTUI React (`@opentui/react`). Entry: `index.tsx` `runTui` → `openTui` → `renderApp`.

### How to read the TUI (do not start in overlays)

Overlays are **modals** (slash palette, confirm, log details, theme picker). They are not the architecture. Behavior lives in hooks + `Controller`.

| Area | Path | Role |
|------|------|------|
| Shell | `App.tsx` | Screen switch, wires hooks, renders chrome |
| Chrome | `chrome.tsx`, `layout.tsx`, `density.tsx` | Header, nav, status bar |
| Screens | `screens/*.tsx` | Dashboard, Services, Logs, Auth, Proxy, Doctor, Config, Settings, MCP, LLM, Stats, Profiles, Setup, … |
| Overlays | `overlays/*.tsx` | Slash, Help, Plan, Confirm, ConfigEdit, SetupWizard, TraceView, … |
| Hooks | `hooks/` | Data, commands, keys |
| Helpers | `helpers/` | Pure formatting / navigation (production imports these, not the old barrel except tests) |
| Keys | `keymap.ts`, `commands.ts`, `tui-config.ts`, `settings.ts`, `themes.ts` | Bindings and prefs |
| Workspace | `workspace.ts` | `ClientRuntime` adapted for screens (plans, doctor) |

Hook map:

| Hook | Owns |
|------|------|
| `use-daemon-events.ts` | Subscribe to bus; merge snapshot |
| `use-lifecycle.ts` | Start/stop/restart/plan |
| `use-log-view.ts` | Filter, window, follow, paging |
| `use-llm-view.ts` | LLM inspector paging |
| `use-diagnostics.ts` | Doctor |
| `use-service-environment.ts` | Env inspect (redacted) |
| `use-config-editor.ts` | Buffer validate via `validateConfigText` before write |
| `use-mcp-controls.ts` | MCP start/stop/tools |
| `use-preferences.ts` | Theme, keys, persist `tui.json` |
| `use-command-dispatcher.ts` | Slash / command catalog |
| `use-setup-wizard.ts` | First-run |
| `use-app-keyboard.ts` | Top-level keymap; delegates to `keyboard-screens.ts` / `keyboard-overlays.ts` |

Boot: attach existing daemon first (even if local YAML is broken). If none: valid config spawns daemon; missing config → Setup screen; invalid YAML → boot error, nothing started.

`helpers.ts` is a compatibility barrel. New code should import `helpers/<file>.ts` directly.

## MCP — `presentation/mcp/`

Streamable HTTP, JSON-RPC 2.0, protocol `2025-03-26`. Bind loopback only. Bearer token (`shared/mcp-token.ts`, TTL). Peer must be loopback (`domain/net/hosts.ts`).

| File | Role |
|------|------|
| `server.ts` | HTTP + JSON-RPC methods (`initialize`, `tools/list`, `tools/call`, resources) |
| `tools.ts` | Tool table, `callMcpTool`, redaction, resources `devctl://…` |
| `port.ts` | Port pick |
| `docs-search.ts` | Search embedded user docs |
| `snippets.ts` | YAML snippets for setup |
| `*.generated.ts` | Synced docs/skill text |

Tools (names are the RPC contract; do not rename lightly):

Inspect: `list_services`, `get_service`, `get_status`, `get_requests`, `get_llm_calls`, `get_llm_call`, `list_profiles`, `get_config`, `get_config_sources`

Logs: `get_logs`, `get_trace`, `trace_request`, `recent_errors`

Diagnostics: `run_doctor`, `search_docs`, `get_doc`, `validate_config`

Control (mutating): `start_services`, `stop_services`, `restart_services`, `reload_config`, `run_task`, `start_proxy`, `stop_proxy`

Setup: `get_setup_guide`

Default-off: `exec_service` (opt in via TUI `mcp_enabled_tools`). Deny-list: `mcp_disabled_tools`.

`get_config` is redacted. Full config is not an MCP resource.

## Web UI — `presentation/web/` + `app/web/`

`WebHttpServer` serves the bundled SPA (`assets.generated.ts`) and JSON by **reusing MCP tool functions** (`listServices`, `getLogs`, control POSTs). Same bearer and loopback rules. Author UI in `app/web/` (pages: overview, logs, traces, graph, llm). Rebuild assets after UI changes.

`web.control.ts` / `api.ts` talk to those HTTP routes. This is not a second orchestrator.

## Shared presentation constraints

- Redact secrets with `Detector` / domain redact helpers before display.
- Do not print tokens in status lines.
- Long work (start, doctor, token refresh) must be async so the TUI stays responsive.
