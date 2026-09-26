# Testing and CI

Runtime is **Bun 1.4.2+**. Tests: `bun:test`. There is no Jest/Vitest.

## Local loop

From `app/`:

```bash
bun install
bun test
bun run check:coverage      # bun test --coverage + aggregate floor (86% funcs/lines)
bun run typecheck           # tsc app + tsc -p web
bun run check:architecture
bun run check:dead          # knip-bun
bun run check:dup           # jscpd src scripts
```

`check-coverage.ts` parses the **All files** line. Per-file thresholds would fail on ignored OpenTUI screens. Floors: `MIN_FUNCS = 86`, `MIN_LINES = 86`.

## What to test where

| Kind | Location | Notes |
|------|----------|-------|
| Domain invariants | `domain/**/*.test.ts` | Plans, transitions, redact, env-ref |
| Loader | `adapters/config/*.test.ts` | Include unknown-field and overlay cases |
| Orchestrator / health | `application/*.test.ts` | Fake `ProcessRuntime` + fake session |
| Supervisor integration | `adapters/daemon/*.test.ts` + `bootstrap/test-supervisor.ts` | Fake Google; real local processes when needed |
| RPC | `adapters/rpc/*.test.ts` | Framing, auth, droppable events |
| CLI | `presentation/cli/*.test.ts` | `bootstrap/test-client.ts` |
| TUI hooks | `presentation/tui/hooks/*.test.ts`, `bootstrap/tui-hooks.test.ts` | Stale results, pinned log windows |
| MCP | `presentation/mcp/*.test.ts` | Tool gate, redaction, docs search |
| Google | `google.test.ts`; `google.integration.test.ts` | Integration skipped without credentials |
| Containers | `containers.integration.test.ts` | `DEVCTL_CONTAINER_TESTS=1` (Linux `container-tests` job; skipped on macOS CI — hosted runners have no Docker) |
| End-to-end scenarios | `app/e2e/*.e2e.test.ts` | `DEVCTL_E2E=1`; real CLI and daemon (see below) |
| Architecture checker | `architecture.test.ts` | Forbidden import examples |

Prefer fakes at ports over mocking module internals. Do not add architecture allowlist entries; fix the import.

## End-to-end scenarios (`app/e2e/`)

Each scenario runs the real CLI and daemon against a throwaway repository, one
documented promise per scenario. They are skipped unless `DEVCTL_E2E=1`, so a
plain `bun test` stays fast.

```bash
cd app
bun run e2e:setup                     # once: pinned Python/Node OTel exporters
bun run e2e                           # every scenario
DEVCTL_E2E=1 bun test e2e/log-prose.e2e.test.ts   # one scenario
```

`e2e:setup` (`e2e/setup.sh`) creates a virtualenv at `e2e/.deps/venv` from
`e2e/fixtures/otel-python/requirements.txt` and runs `npm ci` in
`e2e/fixtures/otel-node`. Both are pinned, transitive packages included, and
gitignored once installed. Only the exporter scenario needs them.

`DEVCTL_E2E_BIN=/path/to/devctl` runs the scenarios against a compiled binary
instead of `bun src/bin.ts`.

| Scenario | Covers |
|----------|--------|
| `ports-auto-health` | `http`, `grpc` and `tcp` health on `ports: auto` (#111) |
| `otel-exporters` | Stock Python and Node OTLP/HTTP protobuf exporters deliver spans and logs (#112) |
| `log-prose` | A line that ends in JSON keeps its prose as the body (#113) |
| `parallel-checkouts` | Two checkouts of one config run side by side (#117, known failure) |
| `compose-import` | `config import compose` output validates, with and without published ports (container start pending #120) |
| `config-validate` | A command array with `;` in an argument validates (#136, known failure) |
| `docs-examples` | Every complete config example in `docs/*.md` passes `config validate` |

### Adding a scenario

1. Create `app/e2e/<name>.e2e.test.ts` and wrap it in `describeE2E(...)`
   from `harness.ts`.
2. Build a repository with `Sandbox.create(name, { ".devctl/config.yaml": ..., "other/file": ... })`.
   Each sandbox gets its own `DEVCTL_HOME` under `/tmp` (kept short for the
   macOS socket-path limit).
3. Drive it through `sandbox.cli([...])`, `sandbox.start([...])`,
   `sandbox.status()` (`status --json`) and `sandbox.logs([...])`
   (`logs --json`). Use `waitFor(...)` for anything asynchronous, and probe
   services over HTTP directly when that is the promise.
4. Tear down in `afterEach` with `await sandbox.down()`. It runs
   `devctl down` and fails the test if the supervisor or any service it
   started is still running.
5. Use `ports: auto` unless the scenario is about pinned ports, pass
   `SCENARIO_TIMEOUT_MS` as the test timeout, and write inline service code to
   a file in the sandbox. The validator rejects `;` inside a command array
   (#136).
6. Add the scenario to the table above.

### Known failures

A scenario for an open bug uses `test.failing(...)` and names the issue. It
passes while the bug reproduces. Once the fix lands, Bun fails it with "this
test is marked as failing but it passed", so the fix PR removes `.failing` in
the same change. Before marking a scenario as a known failure, confirm it fails
for the reason the issue describes, not a harness problem.

## Generated fixtures

After editing `docs/*.md` (top-level), `skills/devctl-onboard/`, or `skills/devctl-debug/`, run `bun run sync-guide` or `docs-search.test.ts` / `guide.test.ts` fail.

After editing `app/web/`, run `bun run build:web`.

## Knip (`knip.jsonc`)

Errors on unused files, dependencies, exports (values). Types are off (RPC DTOs and barrels). Ignored: `ports/credential-provider.ts`, `plugin-sdk.ts`. Host binaries `explorer`, `xdg-open`, `vm_stat` are ignored.

## jscpd

`bun run check:dup` on `src` and `scripts`. If you must duplicate, extract a helper rather than raising the threshold.

## GitHub Actions (`.github/workflows/ci.yml`)

Jobs (all must pass except dependency-review skipped on non-PR):

| Job | What |
|-----|------|
| tests | `check:coverage` |
| typecheck | `tsc --noEmit` |
| architecture | `check:architecture` |
| hygiene | knip + jscpd |
| container-tests | Docker lifecycle |
| demo-config | `devctl config validate` in `examples/demo-platform` |
| compile-smoke | `compile-binaries.sh` + `smoke-test-binary.sh` |
| npm-package-build / smoke | Pack + install matrix (Linux/macOS/Windows/Alpine) |
| windows-tests | `bun test` on windows-latest |
| macos-tests | `bun test` on macos-15 (Docker-gated tests stay skipped) |
| e2e | `bun run e2e:setup` + `bun run e2e` on ubuntu-latest and macos-15 |
| audit | `bun audit` |
| codeql | JS/TS on `app` |
| dependency-review | PRs, fail on high |

Bun version in CI is pinned to **1.4.2** (`oven-sh/setup-bun`).

Other workflows: `release.yml` (tagged publishes, plus `workflow_dispatch` to retry an existing `v*` tag), `docs-wiki.yml` (wiki from `docs/`), `deploy-pages.yml` (VitePress). Compile-smoke also runs `.github/scripts/upload-release-assets.test.sh` and `.github/scripts/compose-github-release-notes.test.sh`.

## Architecture exceptions

There are none in production. `*.test.ts` is a first-class layer. If a test needs adapters + presentation, that is allowed. If production presentation needs an adapter, put it on `ClientRuntime` instead.
