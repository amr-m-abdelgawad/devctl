# Authoring rules the loader enforces

The JSON Schema (`schema/devctl.config.schema.json`) describes the shape.
This file describes what the **loader and validator actually reject** — the
rules that turn a schema-plausible config into one that fails at
`devctl config validate`. Check anything you are unsure of here before writing.

---

## Unknown fields are rejected everywhere

Not warned about — rejected, with the offending path named. These are the
complete allowlists.

**Top level:** `version` `project` `google` `profiles` `templates` `services`
`proxy` `logs` `auth` `shutdown` `ui` `secrets` `doctor` `plugins`
`environment`

**Service** (and `templates.<name>`, same shape): `extends` `description`
`command` `shell` `working_dir` `dependencies` `ports` `environment` `health`
`identity` `logs` `restart` `startup` `capabilities` `proxy`

| Section | Allowed keys |
|---|---|
| `project` | `name` |
| `google` | `project_id` `region` |
| `profiles.<name>` | `services` `environment` |
| `service.health` | `type` `url` `address` `command` `interval_seconds` `timeout_seconds` |
| `service.identity` | `type` `mode` `service_account` |
| `service.restart` | `enabled` `policy` `max_retries` `backoff_seconds` |
| `service.startup` | `wait_for_healthy` `timeout_seconds` |
| `service.logs` | `stdout` `stderr` |
| `service.environment` | `required` `defaults` + arbitrary `KEY: value` pairs |
| `proxy` | `enabled` `listen` `token_endpoint` `routes` |
| `proxy.listen` | `host` `port` |
| `proxy.token_endpoint` | `enabled` `host` `port` |
| `route` | `name` `match` `upstream` `auth` |
| `route.match` | `host` `path` |
| `route.upstream` | `url` |
| `route.auth` | `type` `identity` `audience` `service_account` |
| `logs` | `max_memory_events` `persistence` |
| `logs.persistence` | `enabled` `directory` `retention_days` `max_session_logs` |
| `auth` | `refresh_threshold_seconds` |
| `shutdown` | `stop_services_on_exit` `grace_seconds` |
| `ui` | `theme` `keymap` |
| `secrets` | `extra_markers` `extra_patterns` |
| `doctor` | `tools` (each `{ name, command }`) |
| `plugins[]` | `path` |
| `environment` | `sources` `secrets` |

There is no `depends_on`, no `image`, no `build`, no `volumes`, no `replicas`,
no `env_file` — those are compose/k8s spellings and will be rejected. Translate
them.

---

## Required, at minimum

- `version: 1`. Anything else: *unsupported config version N; no migration is
  available.*
- **At least one service.** An empty or missing `services` map fails with *at
  least one service must be defined* — so a proxy-only or profiles-only config
  is not valid.
- Every service needs a non-empty `command`.

---

## Ports

- **Globally unique across all services.** Two services on `8000` gives
  *duplicate port 8000 used by api and worker*. This is the single most common
  failure when onboarding a repo whose services each assumed they owned the
  default port.
- Range 1–65535.
- Forms accepted: a named map (`ports: { http: 8000 }`, preferred), a list, a
  bare number, or `auto`. `auto` is exempt from the uniqueness check —
  devctl allocates at start.
- Name the port `http` when it serves HTTP.
- Prefer the explicit `${services.X.ports.http}` reference form. The short
  `${services.X.port}` form is only unambiguous for a single-port service: once
  the service is running it prefers the assigned port named `http`, but when it
  resolves against the configuration it takes the **first port declared**,
  whatever its name. Two forms of the same reference disagreeing on a
  multi-port service is a genuinely confusing bug to chase.

## References

`${services.<name>.ports.<portname>}` and `${services.<name>.port}` are the
supported forms. Anything else — `${env.FOO}`, `${project.name}` — throws.

- The referenced service must exist and the named port must be defined, or
  validation fails with *unresolvable reference*.
- References resolve inside service `environment` values, `defaults`, profile
  environments and dotenv values, before the process starts.
- Use them for every cross-service URL. Hard-coded ports silently break when a
  port changes or is switched to `auto`.

## Dependencies

- Must name a service that exists.
- A service may not depend on itself.
- Cycles are rejected: *dependency cycle: a → b → a*.
- Direction: `dependencies` means "start these first". `start x` walks **up**
  and starts x's dependencies; `stop x` walks **down** and stops x's
  *dependents*, never its dependencies.

## Commands and `shell`

A command whose argv contains any of `|` `||` `&&` `;` `>` `>>` `<` `&` is
rejected unless `shell: true`:

```yaml
# rejected
command: "npm run build && npm start"

# correct
command: "npm run build && npm start"
shell: true

# better — no shell needed
command: [npm, start]
```

Prefer argv lists. A string command is split on whitespace, which mangles
arguments containing spaces.

## `working_dir`

Relative to the **repository root** — the directory containing `.devctl` — not
the process cwd, and not the `.devctl` directory itself.

---

## Health

| `type` | Also requires |
|---|---|
| `http` | `url` — omit it and you get *health.url is required for http health checks* |
| `tcp` | `address`, **or** at least one port defined on the service |
| `command` | `health.command` (non-empty) |
| `process` or omitted | nothing; only checks the pid is alive |

Any other `type` is rejected — *health.type must be http, tcp, process, or
command* — **unless** `plugins` is non-empty. That exemption is not approval:
plugins load after validation, so the supervisor re-checks the type at boot and
at reload. A custom type no plugin provides fails as a *reload rejection*, not
a config error, which is much harder to diagnose. Only use a custom type when
you can point at the plugin that registers it.

Defaults when omitted: interval 2s, timeout 2s.

## Identity

- `type: user` (or omitted) needs nothing else.
- `type: service_account` (or `service`) **requires** `service_account`, and it
  must contain `@` — *service_account must be an email*.
- `mode` is an accepted alias of `type`.
- Any other type behaves like a custom health type: allowed only with
  `plugins` set, re-checked at boot.

Never fabricate an SA email. If Terraform interpolates it beyond what you can
resolve, leave a clearly-marked placeholder and tell the user.

## Restart

`policy` must be `never`, `on_failure`, or `always`. `enabled: true` with no
policy behaves as `on_failure`.

`max_retries` is a real budget: it resets on a manual stop/start/restart and
after a sustained healthy run, but an automatic health-triggered restart
preserves it across its own cycle.

## Capabilities

Documentation for doctor, not behaviour. Only these are accepted:
`google` `google_api` `iap` `network` `service_identity` `local_http`.
Anything else is rejected.

---

## Proxy

- `proxy.listen.port` is **required** when `proxy.enabled: true`.
- `proxy.listen.host` must be an IP or `localhost`. `0.0.0.0` is rejected.
- `proxy.token_endpoint.host` must be loopback; `0.0.0.0` is rejected.
- Every route needs a `name` and an `upstream.url`.
- **Route names must be unique** — including names generated from per-service
  `proxy` fragments.
- `auth.type: iap` requires **both** `audience` and `auth.identity.type`. A
  missing identity type on an IAP route is a configuration error, not a
  default.
- An identity of `service` / `service_account` requires an SA email, from
  either `auth.identity.service_account` or the route's `auth.service_account`.
- `auth.type: none` means no auth at all — any identity left on such a route is
  ignored entirely, and will not be probed at start or by doctor.

### Per-service route fragments

A service's `proxy` key is one route or a list. At load they append into the
**same** global `proxy.routes` list, named `<service>` or `<service>-<n>`:

```yaml
services:
  api:
    command: [python3, main.py]
    proxy:
      - match: { path: /api }
        upstream: { url: "http://127.0.0.1:8000" }
```

That generates a route named `api`. So a service named `api` **and** a global
route named `api` collide — *duplicate route name api*. Watch for this when
mixing both styles.

Matching is host + optional path prefix. There is no path rewriting or
stripping: the matched path is forwarded to the upstream as-is.

---

## Modular layout

When the main file is `.devctl/config.yaml`, these merge in automatically:

```
.devctl/services/<name>.yaml   → services.<name>          (FILENAME is the key)
.devctl/profiles/<name>.yaml   → profiles.<name>
.devctl/proxy/routes.yaml      → proxy.routes             (see the wrapper below)
```

A service or profile file contains that object's body **only** — no `services:`
wrapper, no `version:`. Getting this wrong reads oddly: a `services:` wrapper
inside `.devctl/services/api.yaml` reports
`unknown fields: services.api.services`.

`proxy/routes.yaml` is the exception: it accepts either a full `proxy:` wrapper
or a bare top-level `routes:` list. Both append to the same global route list.

```yaml
# .devctl/proxy/routes.yaml — wrapper form, also lets you set proxy.listen here
proxy:
  routes:
    - name: invoices-api
      match: { host: invoices-api.local }
      upstream: { url: "http://127.0.0.1:18000" }
```

```yaml
# .devctl/proxy/routes.yaml — bare form, equivalent for routes alone
routes:
  - name: invoices-api
    match: { host: invoices-api.local }
    upstream: { url: "http://127.0.0.1:18000" }
```

Pick one. Both keys in the same file append **both** lists, which trips the
duplicate-route-name check.

Overlays merge after the repo config, later wins:
built-in defaults → repo `.devctl` → `~/.devctl/config.local.yaml` →
`.devctl/config.local.yaml` — the repo-local overlay wins over the home one.
Overlays are presence-aware:
`false`, `0` and
empty collections in an overlay do override, so `proxy.enabled: false` in a
local overlay genuinely turns the proxy off.

---

## Environment

Merge order — later sources win:

```
process → profile → dotenv → generated → keychain → secret_manager → defaults → vars → runtime
```

`process`, `defaults`, `vars` and `runtime` always run. Listing
`environment.sources` **adds** optional sources (`profile`, `dotenv`,
`generated`, `keychain`, `secret_manager`) to that always-on set — it does not
replace it, and it does not reorder anything.

- `dotenv` reads repo root then `working_dir`: `.env`, `.env.development`,
  `.env.local`, `.env.<profile>`.
- `keychain` and `secret_manager` throw when listed and the fetch fails, so
  only list them when the repo genuinely uses them.
- `environment.required` on a service fails the start if those keys are still
  empty after the whole merge — the right place to encode "this cannot run
  without X".

Runtime values devctl injects: `SERVICE_PORT`, `SERVICE_HOST`,
`DEVCTL_PROXY_URL`, `DEVCTL_SERVICE_NAME`, `DEVCTL_ENVIRONMENT`,
`DEVCTL_TOKEN_URL`, `DEVCTL_INTERNAL_TOKEN`. Do not define these yourself.

---

## Templates

```yaml
templates:
  python-http:
    health: { type: http, interval_seconds: 2, timeout_seconds: 1 }
    logs: { stdout: true, stderr: true }
    restart: { policy: on_failure, max_retries: 2, backoff_seconds: 1 }

services:
  api:
    extends: python-http
    command: [python3, main.py]
    health: { url: "http://127.0.0.1:8000/health" }   # merged field-by-field
```

- `extends` must name a template that exists.
- Nested sections merge **field by field**, so a service can override one
  health field without restating the rest.
- A template is not a service and is never started.

---

## Reading validation output

Every message names its path. Fix the path it names.

| Message | Meaning |
|---|---|
| `at least one service must be defined` | empty/missing `services` |
| `duplicate port N used by X and Y` | two services pinned the same port |
| `services.X.command is required` | missing or empty command |
| `services.X.command contains shell metacharacters` | add `shell: true` or use argv |
| `services.X.dependencies: unknown service "Y"` | typo, or Y lives in a file you did not create |
| `dependency cycle: a → b → a` | remove an edge |
| `services.X.health.url is required for http health checks` | add `url`, or change the type |
| `services.X.identity.service_account must be an email` | placeholder left unresolved |
| `services.X.environment.K: unresolvable reference ${…}` | referenced service or port name does not exist |
| `services.X.capabilities: unknown capability "c"` | only the six listed above are accepted |
| `profiles.P references unknown service "S"` | profile lists a service that is not defined |
| `proxy.routes[i]: duplicate route name N` | often a per-service fragment colliding with a global route |
| `proxy.routes[i].auth.audience is required when auth.type is iap` | IAP needs both audience and identity.type |
| `proxy.listen.port is required when proxy.enabled is true` | pin a port |
| `unsupported config version N (expected 1)` | `version:` must be `1` |
| `unknown fields: services.a.depends_on` | not in the allowlists at the top of this file — usually a compose or k8s spelling |

Every message above is the validator's exact wording. `devctl config validate`
prints one per line and exits 2; a clean run prints `configuration is valid`
and exits 0.
