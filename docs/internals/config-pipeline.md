# Config pipeline

User-facing merge order is in [configuration.md](../configuration.md). This page is **how the loader is implemented** and which file to change for a new field.

## Pipeline (`adapters/config/load.ts`)

```text
discover(startDir, --config)
    → loadPath(repoRoot, configPath)
        decodeFile(main YAML)          // decode.ts + merge.applyRoot
        loadModular(.devctl/{services,profiles,http,proxy/routes.yaml})
        applyLocalOverlays             // ~/.devctl/config.local.yaml then .devctl/config.local.yaml
        migrate()
        applyTemplates()
        mergeServiceProxyRoutes()
        applyProxyCredentials()
        provenance = presence.provenance
        validate()                     // throw KindConfiguration if any issue
```

`load` uses `discover` then `loadPath`. `loadOrEmpty` catches **only** `KindConfigurationMissing`.

`validateConfigText(repoRoot, configPath, text)` substitutes `candidateText` at the main-file read so the TUI buffer (`v` / `/buffer`) runs the **real** pipeline, including modular files and overlays.

## Discovery (`discover.ts`)

Walk from cwd (or `--config`) upward:

1. `<dir>/.devctl/config.yaml`
2. `<dir>/devctl.yaml`

`--config` pointing at a directory named `.devctl` → repo root is its **parent**. Pointing at a file → repo root is that file’s directory, or parent if the directory is `.devctl`.

## Decode vs schema

| Mechanism | File | Catches |
|-----------|------|---------|
| JSON Schema | `schema/devctl.config.schema.json` | Types, required `version: 1`, documented fields |
| Unknown keys | `strict.ts` + `known.ts` | Extra YAML keys (`additionalProperties` analogue) |
| Semantic rules | `validate.ts` | Cycles, duplicate ports, bad refs, plugin types, … |
| Authoring rules **not** in the schema | `skills/devctl-onboard/references/authoring.md` | Loader-only constraints agents miss if they only read the schema |

`schema-parity.test.ts` fails if schema properties drift from `known.ts` / decode. When you add a field:

1. `domain/config/types.ts` (+ `empty*` / defaults)
2. `decode.ts` / `merge.ts` (presence-aware so overlays do not clobber with empty)
3. `known.ts` + `schema/devctl.config.schema.json`
4. `validate.ts` if there is an invariant
5. `migrate.ts` if old files need a rewrite
6. Tests in `validate.test.ts` / `load.test.ts` / `schema-parity.test.ts`

Do not author YAML from the schema alone.

## Modular files

Under `.devctl/`:

- `services/*.yaml` — keyed by filename stem; `mergeService` if the main file already defined the name
- `profiles/*.yaml`
- `http/*.yaml` — recipes
- `proxy/routes.yaml` — may set `proxy:` scalars **and** append `routes`

Unknown fields are checked with a prefix (`services.api.…`) so errors name the service.

## Templates

`templates:` in YAML merge into services that `extends:` them (`applyTemplates`). Template fields are defaults; the service wins.

## Provenance

`merge.ts` records `{ source, layer }` per path. Layers include `main`, `modular_service`, `home_local`, `repo_local`, …. `configDiff` / MCP `get_config_sources` expose this. Overlays are gitignored; they still show up in provenance.

## Environment references

`refs.ts` `resolveEnvMap` expands `${services.*.ports.*}`, `${identity.user}`, `${http.*.*}`, etc. **Rejected** in service env: `${env.NAME}` (too easy to hide required process env). Recipe URL/headers/body and IAP `client_secret` are the documented exceptions and expand at fetch/mint time from process env.

## TUI preferences (separate pipeline)

Not YAML. `tui-preferences.ts`:

1. `DEVCTL_TUI_CONFIG` / `OPENCODE_TUI_CONFIG` → that file only
2. Else first of `./tui.jsonc`, `.devctl/tui.jsonc`, `~/.devctl/tui.jsonc`
3. Merge `~/.devctl/tui.json` on top if it is a different path

Writes go to `~/.devctl/tui.json` unless the env override is set.

## Reload

`adapters/daemon/reload.ts` re-runs load, diffs with `domain/config/snapshot.ts`, records `restartRequired`, reapplies plugin registry, rebinds health/LLM factories. Live processes are not killed until the user restarts (or watch/reload policy says so). Failed reload publishes `ConfigurationReloadFailed` and keeps the last-known-good in-memory config.

## Demo fixture

`demo.test.ts` / `examples/demo-platform/.devctl/` is the CI-validated real config. Prefer adding cases there over inventing YAML in unit tests when testing the full loader.
