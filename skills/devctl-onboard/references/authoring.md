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
`tasks` `http` `proxy` `logs` `auth` `shutdown` `ui` `secrets` `doctor` `plugins`
`environment` `telemetry` `web` `llm`

**Service** (and `templates.<name>`, same shape): `extends` `description`
`command` `shell` `working_dir` `dependencies` `ports` `environment` `health`
`identity` `logs` `restart` `startup` `capabilities` `proxy` `expose` `container` `watch` `hooks`

| Section | Allowed keys |
|---|---|
| `project` | `name` |
| `google` | `project_id` `region` |
| `profiles.<name>` | `services` `environment` |
| `service.health` | `type` `url` `address` `command` `interval_seconds` `timeout_seconds` `start_period_seconds` `unhealthy_threshold` `healthy_reset_threshold` |
| `service.hooks` | `pre_start` `post_start` |
| `service.container` | `image` `runtime` `ports` `env` `volumes` `user` `memory` `cpus` `read_only` `cap_drop` `pids_limit` |
| `service.watch` | `enabled` `paths` `debounce_ms` `ignore` |
| `tasks.<name>` | `command` `shell` `working_dir` `dependencies` `environment` |
| `service.identity` | `type` `mode` `service_account` |
| `service.restart` | `enabled` `policy` `max_retries` `backoff_seconds` |
| `service.startup` | `wait_for_healthy` `timeout_seconds` |
| `service.logs` | `stdout` `stderr` |
| `service.environment` | `required` `defaults` + arbitrary `KEY: value` pairs |
| `service.expose` | `enabled` `host` `port` (or the `true` shorthand) |
| `proxy` | `enabled` `gateway` `credentials` `listen` `token_endpoint` `routes` |
| `proxy.listen` | `host` `port` |
| `proxy.token_endpoint` | `enabled` `host` `port` |
| `route` | `name` `transport` `listen` `match` `upstream` `auth` `response_headers` |
| `route.match` | `host` `path` |
| `route.upstream` | `url` `service` `port` `recipe` |
| `route.auth` | `type` `identity` `audience` `service_account` `client_id` `client_secret` `credentials` `headers` |
| `http.<name>` | `request` `outputs` `cache` `expose` |
| `http.<name>.request` | `method` `url` `headers` `body` `form` `auth` `timeout_seconds` |
| `http.<name>.cache` | `jwt` `expires_in` |
| `http.<name>.expose` | `enabled` `host` `response_headers` (or the `true`/`false` shorthand) |
| `logs` | `max_memory_events` `persistence` |
| `logs.persistence` | `enabled` `directory` `retention_days` `max_session_logs` |
| `telemetry` | `otlp` |
| `telemetry.otlp` | `enabled` `listen` |
| `web` | `enabled` `listen` |
| `llm` | `enabled` `sources` |
| `llm.sources[]` | `name` `type` `service` `port` `endpoint` `path_prefix` `headers` `via` `management_endpoint` `management_service` `management_port` `auth` `capture` `poll_seconds` |
| `llm.sources[].auth` | `type` `token_env` `header` |
| `llm.sources[].via` | `route` |
| `llm.sources[].capture` | `prompts` |
| `auth` | `refresh_threshold_seconds` |
| `shutdown` | `stop_services_on_exit` `grace_seconds` |
| `ui` | `theme` `keymap` |
| `secrets` | `extra_markers` `extra_patterns` |
| `doctor` | `tools` (each `{ name, command }`) |
| `plugins[]` | `path` |
| `environment` | `sources` `secrets` |

There is no `depends_on`, `build`, `replicas`, or `env_file`. Container fields
belong under `service.container`, not directly on the service.

---

## Required, at minimum

- `version: 1`. Anything else: *unsupported config version N; no migration is
  available.*
- **At least one service.** An empty or missing `services` map fails with *at
  least one service must be defined* — so a proxy-only or profiles-only config
  is not valid.
- Every host service needs a non-empty `command`; a container service may rely on its image command.

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

`${services.<name>.ports.<portname>}`, `${services.<name>.port}`,
`${services.<name>.url}`, `${services.<name>.host}`, `${identity.user}` (the
running developer's detected Google email), and `${http.<name>.<output>}`
(a named HTTP recipe snapshot — reserved outputs are `body`, `url`, `status`)
are the supported forms in service/task/profile env. Anything else —
`${env.FOO}`, `${project.name}` — throws there.

- The referenced service must exist and the named port must be defined, or
  validation fails with *unresolvable reference*.
- `${http.<name>.<output>}` must name a defined recipe and output (or a
  reserved output). Named outputs must not use the reserved names.
- References resolve inside service `environment` values, `defaults`, profile
  environments and dotenv values, before the process starts.
- Use them for every cross-service URL. Hard-coded ports silently break when a
  port changes or is switched to `auto`.

HTTP **recipe request** fields (`url`, `headers`, `form`, `body`) are the
exception: they also expand `${token}` (the token minted for that recipe's
`auth` block), `${NAME}`, and `${env.NAME}` from the supervisor process
environment at fetch time. `${token}` requires `request.auth.type` `iap` or
`service_account`. Service env still rejects `${env.NAME}` and `${token}`.

## Dependencies

- Must name a service that exists.
- A service may not depend on itself.
- Cycles are rejected: *dependency cycle: a → b → a*. Recipe-to-recipe cycles
  are rejected separately: *http recipe cycle: a → b → a*.
- Direction: `dependencies` means "start these first". `start x` walks **up**
  and starts x's dependencies; `stop x` walks **down** and stops x's
  *dependents*, never its dependencies. Implicit recipe→service edges are
  startup-only: they do not cascade on stop.
- A string dependency uses `service_started`. Use `{ service: db, condition:
  service_healthy }` to wait for the dependency's configured health check.
  A recipe that interpolates `${services.X.url}` implies the same condition
  (`service_healthy` when X has a health check, otherwise `service_started`).

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

Defaults when omitted: interval 2s, timeout 2s, start period 0s, unhealthy
threshold 3, healthy reset threshold 10. Failures during the start period do
not mark the service unhealthy or consume restart budget.

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
- `proxy.listen.host` must be loopback (`127.0.0.1`, `localhost`, `::1`, or `127.0.0.0/8`). `0.0.0.0` and `::` are rejected.
- `proxy.token_endpoint.host` must be loopback; `0.0.0.0` and `::` are rejected.
- `telemetry.otlp` is **off by default**. When `enabled: true`, `listen.host` must be loopback (`0.0.0.0` / `::` rejected, same as the proxy). Default listen port is **4318**. Host services (not containers) get `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` / `OTEL_SERVICE_NAME` only when those variables are unset. JSON only — no protobuf or gRPC.
- `web` is **off by default**. When `enabled: true`, `listen.host` must be loopback (`0.0.0.0` / `::` rejected). Default listen port is **18900**. It must not collide with `proxy.listen`, `proxy.token_endpoint`, `telemetry.otlp`, or a gRPC route listen port. The listener serves the local telemetry UI (`GET /api/*`) and loopback lifecycle control (`POST /api/control`, same mutating MCP tools except `exec_service`). Request `Host` must be a loopback name; the port in `Host` may differ from the listen port (WSL / Dev Container forwarding).
- `llm` is **off by default**. When `enabled: true`, `sources` must be non-empty. Each source needs a unique `name`, a known `type` (`litellm` or a plugin `llmSources` name), and a unique management hop: `management_endpoint` XOR `management_service`, otherwise exactly one of `service` / `endpoint` / `via.route`. `via.route` may exist alongside `management_*`. Bearer `auth` requires `token_env` (never an inline key). `auth.header` defaults to `Authorization`. `capture.prompts` defaults to true. `via.route` must name an existing proxy route. See [LLM inspector](../../../docs/llm.md).
- Every route needs a `name` and exactly one of `upstream.url`,
  `upstream.service`, or `upstream.recipe`. A service reference must name a
  real service and an existing port (default port name is `http`).
  `service.expose` and `proxy.gateway` synthesize service-reference routes;
  `http.<name>.expose` synthesizes a recipe route. They do nothing unless
  `proxy.enabled` is true. A hand-written route of the same name wins.
- **Route names must be unique** — including names generated from per-service
  `proxy` fragments.
- `auth.type: iap` requires **both** `audience` and `auth.identity.type`. A
  missing identity type on an IAP route is a configuration error, not a
  default.
- Optional `client_id` plus `client_secret` mints the user IAP ID token with
  that OAuth client instead of ADC's default client. Put `${NAME}` or
  `${env.NAME}` in `client_secret` so the value is read from the environment
  at mint time (this is not service-env interpolation). These fields are
  invalid on non-IAP routes and on IAP routes whose identity is a service
  account.
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

## HTTP recipes (`http.<name>`)

Named outbound calls the supervisor makes — not reverse-proxy forwards. Full
shape and Apigee example: [Custom HTTP APIs](../../../docs/http.md).

- `request.url` is required.
- `body` and `form` cannot both be set. `form` is encoded as
  `application/x-www-form-urlencoded`.
- `outputs` keys must not be `body`, `url`, or `status` (those are reserved).
- `expose.enabled` (including `expose: true`) requires `proxy.enabled`.
- `${token}` in the recipe request requires `request.auth.type` `iap` or
  `service_account`. When `Authorization` is already set on the recipe,
  Bearer is not injected (Apigee Basic + `subject_token=${token}`).
- A recipe cannot reference itself. Recipe-to-recipe cycles fail validate.
- Modular files: `.devctl/http/<name>.yaml` — filename is the recipe name,
  body only (no `http:` wrapper).

---

## Modular layout

When the main file is `.devctl/config.yaml`, these merge in automatically:

```
.devctl/services/<name>.yaml   → services.<name>          (FILENAME is the key)
.devctl/profiles/<name>.yaml   → profiles.<name>
.devctl/http/<name>.yaml       → http.<name>              (FILENAME is the key)
.devctl/proxy/routes.yaml      → proxy.routes             (see the wrapper below)
```

A service, profile, or HTTP recipe file contains that object's body **only** —
no `services:` / `http:` wrapper, no `version:`. Getting this wrong reads
oddly: a `services:` wrapper inside `.devctl/services/api.yaml` reports
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
`DEVCTL_TOKEN_URL`, `DEVCTL_INTERNAL_TOKEN`, and `DEVCTL_HTTP_<NAME>_URL` for
each exposed HTTP recipe (host services only). Do not define these yourself.

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
| `http recipe cycle: a → b → a` | two recipes interpolate each other |
| `http.X.request.url is required` | recipe has no url |
| `http.X.request cannot set both body and form` | pick one |
| `http.X.outputs.Y is reserved` | do not name outputs `body`, `url`, or `status` |
| `http.X.expose requires proxy.enabled` | expose needs a running proxy |
| `http.X: ${token} requires request.auth.type iap or service_account` | minting auth is required for `${token}` |
| `proxy.routes[i].upstream requires either url, service, or recipe` | every route needs exactly one upstream kind |
| `services.X.health.url is required for http health checks` | add `url`, or change the type |
| `services.X.identity.service_account must be an email` | placeholder left unresolved |
| `services.X.environment.K: unresolvable reference ${…}` | referenced service or port name does not exist |
| `services.X.capabilities: unknown capability "c"` | only the six listed above are accepted |
| `profiles.P references unknown service "S"` | profile lists a service that is not defined |
| `proxy.routes[i]: duplicate route name N` | often a per-service fragment colliding with a global route |
| `proxy.routes[i].auth.audience is required when auth.type is iap` | IAP needs both audience and identity.type |
| `proxy.routes[i].auth.client_id is only valid when auth.type is iap` | `client_id` / secret only apply to IAP user routes |
| `proxy.routes[i].auth.client_id is required when client_secret is set` | secret without client_id |
| `proxy.routes[i].auth.client_secret is required when client_id is set` | client_id needs a secret |
| `proxy.routes[i].auth.client_id is only valid with identity.type user` | SA IAP uses generateIdToken, not a user OAuth client |
| `proxy.listen.port is required when proxy.enabled is true` | pin a port |
| `unsupported config version N (expected 1)` | `version:` must be `1` |
| `unknown fields: services.a.depends_on` | not in the allowlists at the top of this file — usually a compose or k8s spelling |

Every message above is the validator's exact wording. `devctl config validate`
prints one per line and exits 2; a clean run prints `configuration is valid`
and exits 0.
