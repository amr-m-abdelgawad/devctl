---
name: devctl-onboard
description: Survey a repository — its runnable services, docker-compose, Terraform, Kubernetes manifests, .env files, task runners — and author a validated .devctl configuration for it. Use when asked to onboard a repo to devctl, add or fix .devctl/config.yaml, generate devctl services/profiles/proxy routes, or diagnose why a devctl config fails to load.
---

# Onboarding a repository to devctl

You are producing a `.devctl/` configuration that runs this repository's services
locally, under one supervisor, with the right ports, dependency order, health
checks, environment, and (where the repo talks to Google Cloud) identity and
proxy routes.

Work in four phases: **inventory → draft → validate → verify running**. Do not
skip validation; `devctl` rejects unknown fields and unresolvable references at
load time, so an unvalidated config is usually a broken one.

## Ground rules

- **Read before you write.** Never author a service you have not found a real
  start command for in the repo.
- **Never copy a secret value into YAML.** Reference secrets by name. See
  [Secrets](#secrets-name-only-always) below.
- **Never invent cloud identifiers.** Service-account emails, IAP audiences and
  project IDs come from Terraform, existing config, or the user — not from you.
- **Unknown fields are rejected.** Every key you write must appear in
  `references/authoring.md`. When unsure, check it rather than guessing.
- The user's existing `.devctl/` is theirs. If one exists, treat this as an
  edit, diff your changes, and say what you are changing before you write.

## Phase 1 — Inventory (read-only)

Build a picture of what this repo actually runs. Read
`references/discovery.md` for the full signal → service mapping; the short
version:

```bash
# Runnable units
ls docker-compose*.y*ml Procfile Makefile Taskfile.y*ml 2>/dev/null
find . -maxdepth 3 \( -name package.json -o -name pyproject.toml -o -name go.mod \
  -o -name Cargo.toml -o -name pom.xml -o -name build.gradle\* \) \
  -not -path '*/node_modules/*' -not -path '*/.venv/*'

# Environment surface (names only — do not print values)
find . -maxdepth 3 -name '.env*' -not -path '*/node_modules/*'

# Cloud shape
find . -maxdepth 4 -name '*.tf' -o -name '*.tfvars' | head
find . -maxdepth 4 -path '*k8s*' -name '*.y*ml' -o -name 'skaffold.y*ml'
```

Produce a short table before writing anything — service name, working dir,
start command, port, depends-on, health endpoint, env keys required. Show it to
the user when the repo has more than about three services; that table is the
thing worth correcting, and correcting it is far cheaper than correcting YAML.

Port collisions are the most common inventory error. Ports must be unique
across every service in the config. When the repo does not pin ports, either
assign a contiguous private band (e.g. `18000`, `18001`, …) or use `auto` and
let devctl allocate.

### Terraform: infer, do not transcribe

Terraform describes **deployed** infrastructure. devctl runs **local
processes**. A `google_cloud_run_service` is not a devctl service.

A Terraform resource becomes a devctl service **only when the repo also
contains runnable source for it.** Otherwise it is either a proxy upstream or
nothing at all. What Terraform legitimately contributes:

| Terraform | Becomes |
|---|---|
| `google_service_account` | `identity.service_account`, or a route's `auth.identity.service_account` |
| IAP brand / OAuth client / `iap_web_*` | route `auth.type: iap` + `audience` |
| `google_secret_manager_secret` | a name under `environment.secrets` — never the value |
| `project`, `region` in provider/vars | `google.project_id`, `google.region` |
| Cloud Run / GKE endpoint you do **not** run locally | proxy route `upstream.url` |
| `google_sql_*`, Pub/Sub, buckets | usually just env keys the local service needs |

## Phase 2 — Draft the configuration

Write modular files when there is more than one service — it keeps diffs small
and matches how the demo platform is laid out:

```
.devctl/
  config.yaml          # version, project, google, templates, profiles, proxy, logs
  services/<name>.yaml # one file per service; the FILENAME is the service key
  profiles/<name>.yaml
```

Always start `config.yaml` with the schema hint so the user's editor completes
field names:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/schema/devctl.config.schema.json
version: 1
```

Read `references/authoring.md` before writing YAML. It carries the rules the
JSON Schema does not state — the ones the loader enforces and rejects on.

Guidance that shapes a good first config:

- **Templates over repetition.** Two services sharing a language or runner
  should `extends` a template that holds `health` cadence, `logs`, `restart`.
- **Dependencies are start-order, not networking.** Declare `dependencies` only
  where one service genuinely cannot start usefully before another. Use the
  object form with `condition: service_healthy` only when launch truly requires
  a dependency's health check to pass; strings mean `service_started`.
- **Cross-service URLs use references**, not hard-coded ports:
  `API_URL: http://127.0.0.1:${services.invoices-api.ports.http}`. This keeps
  working when a port changes or is `auto`.
- **Profiles are how people actually start things.** Give at least a small one
  (the API and its dependency) and a full one. `devctl start` with no arguments
  uses the active profile, then the first configured profile — so make the
  first-alphabetically profile a sensible default.
- **Health checks that mean something.** An HTTP service with a `/health`
  endpoint should use `type: http`; a plain `process` check only proves the pid
  is alive and will not catch a wedged service.
- **Proxy routes only when the repo needs injected auth** (IAP, service-account
  impersonation) or must reach a remote upstream. A repo with no cloud auth
  does not need `proxy.enabled: true`.

## Secrets: name-only, always

devctl already reads dotenv files itself. The correct wiring is to declare the
source and name the keys — never to copy values:

```yaml
environment:
  sources: [dotenv]          # repo root then working_dir: .env, .env.development, .env.local, .env.<profile>
  secrets:
    DB_PASSWORD: projects/my-project/secrets/db-password   # a resource NAME
```

```yaml
# in a service
environment:
  required: [DATABASE_URL, AUTH_URL]   # start fails if still empty after the merge
  defaults:
    LOG_LEVEL: INFO
```

### `.env.example` is not a `.env`

The dotenv source reads `.env`, `.env.development`, `.env.local` and
`.env.<profile>`. It does **not** read `.env.example` or `.env.sample`. Those
are the best place to learn which keys exist — and reading them in full is
safe, since they hold placeholders — but a key that only exists there is
unset at start.

So when the repo ships an example file and no real one, do **not** simply
copy its keys into `environment.required` and stop. Pick one:

- List them as `required` **and** tell the user, in your final report, that
  they must `cp .env.example .env` and fill it in before the first
  `devctl start`. This is the better default: it fails fast with a precise
  message naming the missing key.
- Or leave them out of `required` for now, and say which keys you deliberately
  left unenforced.

What you must not do is produce a config whose first start fails with
`missing required environment variable` and no explanation of why — that reads
as a broken config when it is actually correct and under-documented.

Rules you must hold to:

- Do not copy a value out of `.env`, `.tfvars`, a keystore, or CI config into
  any YAML you write.
- Do not echo discovered secret values into your own output either — report the
  **key names** you found, not what they contain.
- Add `secret_manager` to `environment.sources` only when values genuinely look
  like `projects/*/secrets/*`; that source throws if it is listed and the fetch
  fails.
- If a `.env` file is committed and contains real credentials, say so — that is
  a finding worth reporting, separate from the config work.

## Phase 3 — Validate

This is not optional, and it is a loop: fix, re-run, repeat until clean.

```bash
devctl config validate
```

```bash
devctl config show
```

`validate` checks YAML syntax, required fields, unknown fields, service and
profile references, dependency cycles, duplicate ports, identities, proxy
routes (including per-service `proxy` fragments merged at load), and
environment references. Every message names the exact path
(`services.api.health.url is required for http health checks`), so fix the path
it names rather than rewriting the file.

When devctl's MCP server is connected, `validate_config` does the same thing
without a shell, and it additionally accepts **candidate text** — so you can
check a draft *before* writing it:

```
validate_config { "text": "<the config.yaml you are about to write>" }
```

Either way, do not substitute `reload_config` for validation: reload runs
against a daemon and rejects the whole change, which is a slower and less
specific way to learn the same thing.

## Phase 4 — Verify it actually runs

A config that validates can still be wrong: a bad command, a health URL that
never answers, a dependency in the wrong direction.

```bash
devctl start --profile <smallest-profile>
```

```bash
devctl status
```

```bash
devctl doctor
```

Then read the logs of anything that is not `HEALTHY`:

```bash
devctl logs <service> --level ERROR
```

Stop when you are done, and take the daemon down if you started it:

```bash
devctl down
```

**After any failed start, run `devctl down` before retrying.** A service that
got far enough to bind its port and then failed its health check can still be
holding that port, so the retry fails for a completely different reason than
the first attempt did — and reads like a config error when the config is fine.
Clearing the daemon first keeps you debugging one problem at a time.

Two failures worth recognising, because they look alike and are not:

- `service X missing required environment variable K` — `environment.required`
  did its job. The key is genuinely unset: usually the repo ships `.env.example`
  but no `.env`, since `.env.example` is not one of the files the dotenv source
  reads. Tell the user to create it; do not "fix" it by deleting the
  requirement or inventing a value.
- `service X did not become healthy in time` — the process started but the
  probe never passed. Check the health URL and port against what the command
  actually binds, and raise `startup.timeout_seconds` for slow dev servers
  before assuming the command is wrong.

### When the devctl MCP server is connected

If the agent has devctl's MCP server attached, prefer its tools for the
read-and-observe half of this phase — they return structured data and do not
need a shell:

| Instead of | Use |
|---|---|
| `devctl status` | `list_services`, `get_status` |
| `devctl logs …` | `get_logs` (200/page; page with `cursor` from `next_cursor`) |
| `devctl doctor` | `run_doctor` |
| `devctl config show` | `get_config` |
| `devctl start --profile p` | `start_services` with `profile: p` |
| `devctl reload` | `reload_config` |
| `devctl config validate` | `validate_config` (also takes candidate `text`) |

`devctl down` has no MCP equivalent — use the CLI. MCP tools need the bearer token
from `devctl mcp`; if calls fail with 401, the token is stale — re-copy the
snippet rather than retrying.

## Reporting

Finish with:

1. What you found — services, their ports, what you inferred from Terraform.
2. What you wrote — the file list.
3. `devctl config validate` output (clean, or what remains).
4. What you could **not** determine and left as a placeholder — service-account
   emails, IAP audiences, and remote upstream URLs are the usual ones. Name
   them explicitly; a plausible-looking wrong SA email is worse than a marked
   gap.

## References

- `references/discovery.md` — signal → service mapping per ecosystem, including
  Terraform, docker-compose, and Kubernetes.
- `references/authoring.md` — the loader's real rules: allowed fields, port and
  reference constraints, health/identity/proxy requirements, common rejections.

Both are also served by the MCP server itself, as
`get_setup_guide { "section": "discovery" | "authoring" }` — the same text,
compiled into the devctl binary. If you reached this procedure through MCP,
there is nothing to install: fetch the sections you need from there.

### Starting from nothing

`devctl mcp --on` works in a repository with no `.devctl` at all — the daemon
boots in **setup mode**, which is what makes "install devctl, turn on MCP, ask
the agent to set it up" a complete path. In that state `get_status` reports
`setup_mode: true`, no service can start, and `validate_config` with no
arguments reports the missing configuration rather than a parse error. Draft,
validate the candidate text, write the files, then call `reload_config`: setup
mode clears on the reload that finds a valid configuration.
