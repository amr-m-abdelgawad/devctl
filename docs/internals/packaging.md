# Packaging and release

## Version sources (must match)

- `app/package.json` `"version"`
- `app/src/version.ts` `VERSION` (overridden at compile with `DEVCTL_VERSION`)

`RPC_PROTOCOL_VERSION` is independent. Bump it only for breaking supervisor wire changes.

## Compiled binary

`.github/scripts/compile-binaries.sh` runs `bun build --compile` for release targets. The npm package **embeds** those binaries; the Node launcher in `packaging/npm/` picks the right one.

The Release publish job uploads those standalone files and the npm tarball **one at a time** (`.github/scripts/upload-release-assets.sh`) so a GitHub uploads API 500 does not abort a concurrent batch.

Standalone binaries:

- `Bun.isStandaloneExecutable` changes `_supervisor` argv (`supervisorSpawnCommand`)
- Log worker is skipped
- MCP/docs strings must be compiled in → `sync-guide` before release

Smoke: `.github/scripts/smoke-test-binary.sh`.

## npm (`@amr-m-abdelgawad/devctl`)

| Piece | Path |
|-------|------|
| Build | `app/scripts/build-npm-package.ts`, `npm-package.ts` |
| Launcher tests | `packaging/npm/devctl.test.cjs`, `app` script `test:npm-launcher` |
| Publish | Trusted Publishing / OIDC via `release.yml` environment `npm` |
| Maintainer steps | [npm-publishing.md](../npm-publishing.md) |

No npm token in the repo. Tag `vX.Y.Z` on `main` after CI is green.

## Homebrew

`app/scripts/homebrew-formula.ts` + `update-homebrew-formula.ts`. Release workflow may open a checksum PR (needs “Actions can create PRs”).

## Docs site vs wiki vs MCP

| Channel | Source | Notes |
|---------|--------|-------|
| VitePress | `docs/` including `internals/` | `docs/.vitepress/config.ts`; GitHub Pages `deploy-pages.yml` |
| GitHub Wiki | top-level `docs/*.md` | `prepare-wiki.sh` **strips** `internals/` |
| MCP `search_docs` | `docs.generated.ts` | Top-level `docs/*.md` |

`docs/index.md` (landing) and `docs/changelog.md` are VitePress pages and are excluded from the wiki. Wiki home is `docs/README.md` → `Home.md`. The changelog source of truth is repo-root `CHANGELOG.md`.

When you add a **user** page at `docs/foo.md`: add sidebar entries in VitePress config **and** `prepare-wiki.sh` `_Sidebar.md`, then `bun run sync-guide`.

When you add an **internals** page: add it to `docs/internals/README.md` **and** `docs/internals/index.md` (keep those two hubs in sync) and the VitePress Contribute sidebar only.

## Demo platform

`examples/demo-platform/` is the golden local stack. CI validates its config. Keep it working when you change the loader or defaults.

## Skills

`skills/devctl-onboard/` is for agents configuring **other** repositories. Changing the loader without updating `references/authoring.md` causes silent YAML that the schema accepts and `validate()` rejects.
