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
| Containers | `containers.integration.test.ts` | `DEVCTL_CONTAINER_TESTS=1` |
| Architecture checker | `architecture.test.ts` | Forbidden import examples |

Prefer fakes at ports over mocking module internals. Do not add architecture allowlist entries; fix the import.

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
| audit | `bun audit` |
| codeql | JS/TS on `app` |
| dependency-review | PRs, fail on high |

Bun version in CI is pinned to **1.4.2** (`oven-sh/setup-bun`).

Other workflows: `release.yml` (tagged publishes, plus `workflow_dispatch` to retry an existing `v*` tag), `docs-wiki.yml` (wiki from `docs/`), `deploy-pages.yml` (VitePress). Compile-smoke also runs `.github/scripts/upload-release-assets.test.sh` and `.github/scripts/compose-github-release-notes.test.sh`.

## Architecture exceptions

There are none in production. `*.test.ts` is a first-class layer. If a test needs adapters + presentation, that is allowed. If production presentation needs an adapter, put it on `ClientRuntime` instead.
