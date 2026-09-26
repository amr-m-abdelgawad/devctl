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
`command` `shell` `working_dir` `dependencies` `ports` `environment`
`environments` `default_environment` `health`
`identity` `logs` `restart` `startup` `capabilities` `proxy` `expose` `container` `watch` `hooks`

| Section | Allowed keys |
|---|---|
| `project` | `name` |
| `google` | `project_id` `region` |
| `profiles.<name>` | `services` `environment` `environments` `service_environment` |
| `service.health` | `type` `url` `address` `grpc_service` `command` `interval_seconds` `timeout_seconds` `start_period_seconds` `unhealthy_threshold` `healthy_reset_threshold` |
| `service.hooks` | `pre_start` `post_start` |
| `service.container` | `image` `runtime` `ports` `env` `volumes` `user` `memory` `cpus` `read_only` `cap_drop` `pids_limit` |
| `service.watch` | `enabled` `paths` `debounce_ms` `ignore` |
| `tasks.<name>` | `command` `shell` `working_dir` `dependencies` `environment` |
| `service.identity` | `type` `mode` `service_account` `config` |
| `service.restart` | `enabled` `policy` `max_retries` `backoff_seconds` |
| `service.startup` | `wait_for_healthy` `timeout_seconds` |
| `service.logs` | `stdout` `stderr` `multiline` `dedupe_access_line` |
| `service.logs.multiline` | `start` `continuation` `max_wait_ms` `max_lines` |
| `service.environment` | `required` `defaults` `terraform` + arbitrary `KEY: value` pairs |
| `service.environment.terraform` | `path` `resource` `attribute`, or a string path |
| `service.environments.<name>` | same shape as `service.environment` |
| `service.expose` | `enabled` `host` `port` (or the `true` shorthand) |
| `proxy` | `enabled` `inspect_max_bytes` `gateway` `credentials` `listen` `token_endpoint` `routes` |
| `proxy.listen` | `host` `port` |
| `proxy.token_endpoint` | `enabled` `host` `port` |
| `route` | `name` `transport` `listen` `match` `upstream` `auth` `response_headers` `inspect` `strip_prefix` `log` `timeout` `transform` |
| `route.timeout` | `idle_ms` `total_ms` |
| `route.transform` | `request_body` |
| `route.transform.request_body[]` | `replace` `with` `regex` |
| `route.match` | `host` `path` |
| `route.upstream` | `url` `service` `port` `recipe` |
| `route.auth` | `type` `identity` `audience` `service_account` `client_id` `client_secret` `credentials` `headers` `log_identity` `suppress_authorization` |
| `route.inspect` | `enabled` `max_bytes` `grpc` `capture_sse` |
| `route.inspect.grpc` | `decoder` |
| `route.log` | `grpc` |
| `route.log.grpc` | `ok` |
| `route.log.grpc.ok[]` | `status` `methods` `log` |
| `route.match` | `host` `path` |
| `route.upstream` | `url` `service` `port` `recipe` |
| `route.auth` | `type` `identity` `audience` `service_account` `client_id` `client_secret` `credentials` `headers` `log_identity` `suppress_authorization` |
| `http.<name>` | `request` `outputs` `cache` `expose` |
| `http.<name>.request` | `method` `url` `headers` `body` `form` `auth` `timeout_seconds` |
| `http.<name>.cache` | `jwt` `expires_in` |
| `http.<name>.expose` | `enabled` `host` `response_headers` `allow_token_body` (or the `true`/`false` shorthand) |
| `logs` | `max_memory_events` `persistence` |
| `logs.persistence` | `enabled` `directory` `retention_days` `max_session_logs` |
| `telemetry` | `otlp` |
| `telemetry.otlp` | `enabled` `listen` |
| `web` | `enabled` `listen` |
| `llm` | `enabled` `capture_max_bytes` `sources` |
| `llm.sources[]` | `name` `type` `service` `port` `endpoint` `path_prefix` `headers` `via` `management_endpoint` `management_service` `management_port` `auth` `capture` `poll_seconds` `cost_per_token` |
| `llm.sources[].auth` | `type` `token_env` `header` |
| `llm.sources[].via` | `route` `routes` |
| `llm.sources[].capture` | `prompts` `max_bytes` `paths` `field_map` |
| `llm.sources[].capture.field_map` | `model` `prompt_tokens` `completion_tokens` `cost` `finish_reason` |
| `llm.sources[].cost_per_token` | `input` `output` |
| `auth` | `refresh_threshold_seconds` |
| `shutdown` | `stop_services_on_exit` `grace_seconds` |
| `ui` | `theme` `keymap` |
| `secrets` | `redact` `extra_markers` `extra_patterns` |
| `doctor` | `tools` (each `{ name, command }`) |
| `plugins[]` | `path` |
| `environment` | `sources` `secrets` `sops` |
| `environment.sops` | `file` `input_type` `key_map` |

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
running developer's detected Google email), `${http.<name>.<output>}`
(a named HTTP recipe snapshot — reserved outputs are `body`, `url`, `status`),
and `${NAME}` / `${env.NAME}` (supervisor process env plus `.devctl/secrets.env`)
are the supported forms in service/task/profile env. `${project.name}` still
throws there. `${token}` is rejected in service env.

- The referenced service must exist and the named port must be defined, or
  validation fails with *unresolvable reference*.
- `${http.<name>.<output>}` must name a defined recipe and output (or a
  reserved output). Named outputs must not use the reserved names.
- References resolve inside service `environment` values, `defaults`, named
  `environments.<name>` overlays, profile environments and dotenv values,
  before the process starts.
- Use them for every cross-service URL. Hard-coded ports silently break when a
  port changes or is switched to `auto`.
- `${env.NAME}` is accepted by `devctl config validate` without the variable
  being set yet. An empty value fails at process start / mint / request time.

HTTP **recipe request** fields (`url`, `headers`, `form`, `body`, `auth.headers`)
also expand `${token}` (the token minted for that recipe's `auth` block),
`${NAME}`, and `${env.NAME}` from the supervisor process environment plus
`.devctl/secrets.env` at fetch time. `${token}` requires `request.auth.type`
`iap` or `service_account`. Service env still rejects `${token}`.

Proxy route strings in `proxy.routes` or `.devctl/proxy/routes.yaml`
(`auth.headers`, `response_headers`, `upstream.url`, `auth.audience`,
`auth.credentials`, `auth.client_secret`, `transform.request_body[].replace`,
`transform.request_body[].with`) expand `${NAME}` / `${env.NAME}` at
request or mint time. `${token}` in `auth.headers` and in `transform.request_body`
`replace` / `with` is substituted at request time on `iap` / `service_account`
routes (the same minted token as `Authorization`). On `auth.type: none`,
`${token}` in a body transform fails validate. Proxy
`auth.headers` are **not** run through full `resolveEnvMap` — `${identity.user}`
there stays literal. `devctl config validate` warns if `${identity.` appears in
those header values or in `transform.request_body` `replace` / `with`.

## Named service environments

`services.<name>.environments` is a map of extra `EnvConfig` overlays (same
shape as `environment`: `required`, `defaults`, plus `KEY: value`). They merge
onto the service's base `environment`; overlay keys win. This is **not** a
start profile — each service is switched independently.

- `default_environment` must name a key in `environments` when set. If it is
  omitted, the first name alphabetically is the default.
- Empty overlay names are rejected.
- Overlay values are validated for references the same way as base
  `environment`.
- Selection is session state, not YAML. Switching does not rewrite the file.

## Profiles

`profiles.<name>` is a start allowlist plus optional env. Starting that profile
does **not** pull in YAML/HTTP dependencies omitted from `services`. Named
`devctl start invoices-api` with no profile still expands the local closure.

- `environments` is service → overlay name (`services.<svc>.environments.<name>`).
  Unknown services and unknown overlay names are rejected. Empty names too.
- `service_environment.<svc>` is an `EnvConfig` (same shape as a service
  overlay). Unknown services are rejected. Refs are validated like other env.
- Fleet-wide `environment` still applies to every member and still loses to
  service vars. Per-service keys live in `service_environment` so they can
  retarget `AUTH_URL` at a deployed backend.

## Dependencies

- Must name a service that exists.
- A service may not depend on itself.
- Cycles are rejected: *dependency cycle: a → b → a*. Recipe-to-recipe cycles
  are rejected separately: *http recipe cycle: a → b → a*.
- Direction: `dependencies` means "start these first". `start x` (no profile)
  walks **up** and starts x's dependencies; `start --profile P` starts **exactly**
  P's members (omitted deps stay remote). `stop x` walks **down** and stops x's
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
| `grpc` | `address` (required; no ports fallback). Optional `grpc_service` is the Health protocol service name; empty (the default) is overall status |
| `command` | `health.command` (non-empty) |
| `process` or omitted | nothing; only checks the pid is alive |

`health.url` and `health.address` may use `${services.<name>.port}`,
`.ports.<name>` (or a fixed port's index), `.host` or `.url`; they expand
before every probe from the currently assigned ports, so an `http` or `grpc`
check works with `ports: auto`. No other reference kind expands in a health field.

`type: grpc` calls `grpc.health.v1.Health/Check` over h2c (TLS/h2 if cleartext
is refused). SERVING is healthy; NOT_SERVING, SERVICE_UNKNOWN, and RPC
failure are not. This only proves **some** process answered Health/Check
(or a Temporal frontend if `address` points at the proxy). A Temporal
**worker** that does not expose Health stays `process`-healthy while
disconnected — use `type: command` or a plugin `healthChecks` for that
case. Do not invent Temporal-specific poll-success health in core.

Any other `type` is rejected — *health.type must be http, tcp, process, command, or
grpc* — **unless** `plugins` is non-empty. That exemption is not approval:
plugins load after validation, so the supervisor re-checks the type at boot and
at reload. A custom type no plugin provides fails as a *reload rejection*, not
a config error, which is much harder to diagnose. Only use a custom type when
you can point at the plugin that registers it.

Defaults when omitted: interval 2s, timeout 2s, start period 0s, unhealthy
threshold 3, healthy reset threshold 10. Failures during the start period do
not mark the service unhealthy or consume restart budget. `startup.wait_for_healthy`
extends that same grace through the startup timeout so a slow first bind cannot
be killed by the probe loop. After a successful probe, later failures stay
`UNHEALTHY` and do not restart a still-running process (Vite HMR / in-process
reload); an actual process exit still follows `restart.policy`.

## Identity

- `type: user` (or omitted) needs nothing else.
- `type: service_account` (or `service`) **requires** `service_account`, and it
  must contain `@` — *service_account must be an email*.
- `mode` is an accepted alias of `type`.
- `config` is an opaque object passed to a **plugin** identity provider. Omit it
  for built-in `user` / `service_account`. Nested keys under `config` are not
  checked against the allowlist.
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
- `telemetry.otlp` is **off by default**. When `enabled: true`, `listen.host` must be loopback (`0.0.0.0` / `::` rejected, same as the proxy). Default listen port is **4318**. Host services (not containers) get `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` / `OTEL_SERVICE_NAME` only when those variables are unset. The receiver accepts OTLP/HTTP JSON or protobuf (optionally gzip), not gRPC.
- `web` is **off by default**. When `enabled: true`, `listen.host` must be loopback (`0.0.0.0` / `::` rejected). Default listen port is **18900**. It must not collide with `proxy.listen`, `proxy.token_endpoint`, `telemetry.otlp`, or a gRPC route listen port. The listener serves the local telemetry UI (`GET /api/*`) and loopback lifecycle control (`POST /api/control`, same mutating MCP tools except `exec_service`). Request `Host` must be a loopback name; the port in `Host` may differ from the listen port (WSL / Dev Container forwarding).
- `llm` is **off by default**. When `enabled: true`, `sources` must be non-empty. Each source needs a unique `name` and a known `type` (`litellm`, `proxy`, or a plugin `llmSources` name). `type: proxy` requires at least one of `via.route` or `via.routes` naming existing proxy routes and must not set `service`, `endpoint`, or `management_*`. Empty `via.routes` entries fail validate. `via.routes` is only valid on `type: proxy`. Pull types (`litellm` and plugins) need a unique management hop: `management_endpoint` XOR `management_service`, otherwise exactly one of `service` / `endpoint` / `via.route`. `via.route` may exist alongside `management_*`. Bearer `auth` requires `token_env` (never an inline key). `auth.header` defaults to `Authorization`. `capture.prompts` defaults to true. `capture.max_bytes` (proxy) defaults to `llm.capture_max_bytes` when omitted or `0`, then 1 MiB. `llm.capture_max_bytes` itself defaults to 1 MiB when omitted or `0`; negative values fail validate. `capture.paths` (proxy) is an optional list of extra path substrings to capture as raw POST JSON pairs; each must start with `/` and must not be `/` alone. `capture.field_map` (proxy only) maps JSONPath-subset paths (`$.request.` / `$.response.`, dotted keys, `[n]` indexes) onto inspector `model` / `prompt_tokens` / `completion_tokens` / `cost` / `finish_reason`; a present mapped value wins over the OpenAI parser, a missing/null path leaves the default. Invalid on `litellm` and plugin sources. `cost_per_token` (proxy only) is an optional `{ input, output }` pair of per-token rates, both `>= 0` numbers when the block is present; invalid on `litellm` and plugin sources. Each `via.route` / `via.routes` name must exist on `proxy.routes`. See [LLM inspector](../../../docs/llm.md).
- `proxy.routes[].inspect` is **off by default**. `inspect: true` or `inspect.enabled: true` captures HTTP or gRPC request/response bodies on that hop for the traffic inspector (TUI proxy screen, web `#/traffic`, MCP `get_traffic_call`, CLI `devctl traffic`). `inspect: true` is `{ enabled: true, max_bytes: 0 }` with no `capture_sse`. `inspect.max_bytes` defaults to `proxy.inspect_max_bytes` when omitted or `0`, then 1 MiB. `proxy.inspect_max_bytes` itself defaults to 1 MiB when omitted or `0`; negative values fail validate. `inspect.grpc.decoder` is an optional plugin `trafficDecoders` name; omit it to pretty-print JSON frames then proto3 `decode_raw`. A named decoder with no `plugins:` fails validate the same way an unknown `health.type` does. `inspect.capture_sse` (default false) stores `text/event-stream` responses as a JSON array of blank-line-delimited event frames, or pretty OpenAI `chat.completion` JSON when the stream is that shape. Non-SSE responses and request bodies ignore the flag; the forwarded stream is still teed with no extra delay. Inspect is ignored when the proxy is off. Recipe `expose` routes are never captured as live RPCs. Direct sockets that never hit the proxy are invisible — callers should use `${services.<name>.url}` or the gRPC listen port. See [Proxy](../../../docs/proxy.md#inspect-bodies).
- `proxy.routes[].strip_prefix: true` strips `match.path` from the pathname **when forwarding only**. Inspector and proxy logs keep the inbound path. No-op when `match.path` is empty (host-based `expose` routes). `/my-service` → `/`, `/my-service/foo` → `/foo`; the query string is preserved. See [Proxy](../../../docs/proxy.md#strip-a-path-prefix).
- `proxy.routes[].transform.request_body` rewrites the HTTP request body before forwarding. Each entry is `{ replace, with, regex? }`. Rules run in order and replace every match. `regex: true` makes `replace` a JavaScript regular expression; otherwise it is literal. `with` is inserted literally (`$` is not a capture). `${NAME}` / `${env.NAME}` expand in `replace` and `with` at request time. `${token}` there is the minted bearer on `iap` / `service_account` routes and is rejected on `auth.type: none`. The body is buffered (16 MiB cap) and must be uncompressed UTF-8. Invalid on gRPC routes and recipe routes. See [Proxy](../../../docs/proxy.md#rewrite-the-request-body).
- `proxy.routes[].log.grpc.ok` lists non-zero gRPC statuses that are **not** proxy errors. Each entry is `{ status, methods?, log? }`. `status` is an integer from 1 to 16. Omit `methods` to apply to every method on that route; otherwise a listed name matches as an exact `:path` or a suffix that starts with `/` (e.g. `PollWorkflowTaskQueue` matches `…/PollWorkflowTaskQueue`, not `…/NotPollWorkflowTaskQueue`). `log` is `info` (default) or `silent`. Unlisted non-zero statuses stay WARN and increment `stats().errors`. See [Proxy](../../../docs/proxy.md#grpc-status-policy).
- `proxy.routes[].timeout` is **opt-in**. `idle_ms` and `total_ms` are milliseconds. `0`, omitted keys, or a missing `timeout` block are unlimited (current behavior — do not set a global default; a 47–65s CopilotKit stream must keep working). Negative or non-finite values fail validate. HTTP returns **504** and aborts the upstream; idle resets on each request or response chunk (including WebSocket data either direction). gRPC uses status **4 DEADLINE_EXCEEDED** (trailers-only if the response has not started); idle resets on DATA frames either direction. See [Proxy](../../../docs/proxy.md#route-timeouts).
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
  `${env.NAME}` in `client_secret`, `credentials`, `audience`, or `auth.headers`
  so the value is read from the environment plus `.devctl/secrets.env` at mint
  or request time. These fields are invalid on non-IAP routes and on IAP
  routes whose identity is a service account.
- An identity of `service` / `service_account` requires an SA email, from
  either `auth.identity.service_account` or the route's `auth.service_account`.
- `auth.type: none` means no auth at all — any identity left on such a route is
  ignored entirely, and will not be probed at start or by doctor.
- Optional `auth.log_identity: true` is valid only on `auth.type: none` (or an
  empty type). It copies inbound `X-Goog-Authenticated-User-Email` onto the
  traffic record as `caller_email`. Rejected on `iap`, `service_account`, and
  other minting types. It does not mint tokens.
- Optional `auth.suppress_authorization: true` is valid only on `iap` /
  `service_account`. The route still mints (`audience`, `identity`, `client_id`,
  `client_secret`, `credentials` unchanged) and still applies `auth.headers`
  with `${token}`, but does not write `Authorization: Bearer`. Use it when the
  caller already sets `Authorization` (a Workspace OAuth token) and IAP must go
  in another header, typically `Proxy-Authorization: "Bearer ${token}"`.
  `${token}` is the raw JWT — include the `Bearer ` prefix in the header value
  when the upstream expects it. Rejected on `auth.type: none`. Requires
  `auth.headers` so the minted token is sent somewhere.
- An IAP route with `auth.credentials` (or the folded `proxy.credentials`) is
  checked at validate: the file must exist, be JSON, have `type` `authorized_user`
  when set, and include `refresh_token` plus a `client_id` that matches the
  route. `devctl status` reports `credentials_valid` on that route snapshot.

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

Matching is host + optional path prefix. Set `strip_prefix: true` on the
fragment (or a global route) to strip `match.path` when **forwarding**;
inspector and proxy logs still show the inbound path. Host-based `expose`
routes have an empty `match.path`, so strip is a no-op there.

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
`.devctl/config.local.yaml` → `.devctl/overlays/<name>.yaml` (session,
`devctl start --overlay <name>`). The repo-local overlay wins over the home
one; a session overlay wins over both locals. Session overlays use the **same
keys** as `config.local.yaml` — they are not a second language. Presence-aware:
`false`, `0` and
empty collections in an overlay do override, so `proxy.enabled: false` in a
local or session overlay genuinely turns the proxy off. A missing
`--overlay` name fails with `overlay "X" not found: .devctl/overlays/X.yaml`.
Named overlay files may be committed; do not gitignore all of `overlays/`.

---

## Environment

Merge order — later sources win:

```
process → profile → dotenv → secrets_env → generated → keychain → sops → secret_manager → defaults → terraform → vars → profile_service → runtime
```

`process`, `secrets_env`, `defaults`, `terraform`, `vars`, `profile_service` and `runtime` always run. Listing
`environment.sources` **adds** optional sources (`profile`, `dotenv`,
`generated`, `keychain`, `sops`, `secret_manager`) to that always-on set — it does not
replace it, and it does not reorder anything. `terraform` is not an
`environment.sources` entry. It reads `services.<name>.environment.terraform`
when that field is set.

- `dotenv` reads repo root then `working_dir`: `.env`, `.env.development`,
  `.env.local`, `.env.<profile>`.
- `keychain` throws when listed and a stored file cannot be read. `secret_manager`
  throws on a malformed resource name or a non-access fetch error (HTTP 404).
  Missing credentials, HTTP 401/403, or a transport failure skip the key so
  dotenv / process env can fill it — listing `secret_manager` also enables
  `dotenv`. Only list these sources when the repo genuinely uses them.
- `sops` decrypts `environment.sops.file` (repo-relative; must stay inside the
  repo) with `sops --decrypt --output-type json` at daemon start and reload.
  `file` is required when `sops` is listed. Optional `input_type` is `json`,
  `yaml`, or `dotenv` (otherwise the extension is used) and selects how SOPS
  reads the file, not the decrypt output. Optional `key_map` maps an env var
  name to a SOPS key; several env vars may share one key, and a mapped SOPS
  key is not also injected under its raw name. Unmapped keys are uppercased.
  Nested objects use a dot path (`db.password` → `DB_PASSWORD`, or a
  `key_map` entry). Arrays are JSON strings. `#`, spaces, and newlines are
  kept. A missing binary, missing file, or failed decrypt skips the source
  with a warning — it does not fail config load. Plaintext is not written to
  disk. `secret_manager` still wins over `sops` when the fetch succeeds.
- `environment.required` on a service fails the start if those keys are still
  empty after the whole merge — the right place to encode "this cannot run
  without X".
- `environment.terraform` on a service (or a named overlay) reads literal env
  values from a `.tf` file or a directory of `*.tf`. `path` is required and
  must stay inside the repo. Optional `resource` is `type.name`, `module.name`,
  or `data.type.name`. Optional `attribute` adds one map name. A string is
  shorthand for `path`. Interpolations and `value_source` secrets are skipped.
  `.tfvars` is not read. The path must contain at least one literal or
  validate fails. Terraform wins over `defaults` and dotenv; explicit YAML
  keys, named overlays, and `service_environment` still win. A `terraform`
  path on `profiles.<name>.service_environment.<svc>` replaces the service
  path for that profile. Do not copy the literals into YAML. See
  `docs/environment.md`.

Runtime values devctl injects: `SERVICE_PORT`, `SERVICE_HOST`,
`DEVCTL_PROXY_URL`, `DEVCTL_SERVICE_NAME`, `DEVCTL_ENVIRONMENT`,
`DEVCTL_SERVICE_ENV` (the selected named overlay; omitted when the service
has none), `DEVCTL_USER_EMAIL` (omitted when no Google identity is detected),
`DEVCTL_TOKEN_URL`, `DEVCTL_INTERNAL_TOKEN`, and `DEVCTL_HTTP_<NAME>_URL` for
each exposed HTTP recipe (host services only). When `telemetry.otlp.enabled`,
host services also get `OTEL_EXPORTER_OTLP_ENDPOINT` /
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` / `OTEL_SERVICE_NAME` if those keys
were unset. Do not define these yourself.

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
| `services.X.health.url: unresolvable reference ${…} (health templates accept only ${services.<name>.…})` | unknown service or port name, or a non-`services.` reference in `health.url` / `health.address` |
| `services.X.identity.service_account must be an email` | placeholder left unresolved |
| `services.X.environment.K: unresolvable reference ${…}` | referenced service or port name does not exist |
| `services.X.environment.terraform.path must stay inside the repository` | path escapes the repo, including via a symlink |
| `services.X.environment.terraform.resource "…" was not found` | `resource` does not match a block in that path |
| `services.X.environment.terraform: no literal env values` | file has only interpolations or secret refs |
| `services.X.capabilities: unknown capability "c"` | only the six listed above are accepted |
| `profiles.P references unknown service "S"` | profile lists a service that is not defined |
| `profiles.P.environments.S references unknown service "S"` | overlay bind names a service that is not defined |
| `profiles.P.environments.S "X" is not defined on services.S` | overlay bind names an overlay the service does not have |
| `profiles.P.service_environment.S references unknown service "S"` | per-service profile env for an unknown service |
| `proxy.routes[i]: duplicate route name N` | often a per-service fragment colliding with a global route |
| `proxy.routes[i].auth.audience is required when auth.type is iap` | IAP needs both audience and identity.type |
| `proxy.routes[i].auth.client_id is only valid when auth.type is iap` | `client_id` / secret only apply to IAP user routes |
| `proxy.routes[i].auth.client_id is required when client_secret is set` | secret without client_id |
| `proxy.routes[i].auth.client_secret is required when client_id is set` | client_id needs a secret |
| `proxy.routes[i].auth.client_id is only valid with identity.type user` | SA IAP uses generateIdToken, not a user OAuth client |
| `proxy.routes[i].auth.log_identity is only valid when auth.type is none` | `log_identity` is opt-in IAP-email copy on `none` routes only |
| `proxy.routes[i].auth.suppress_authorization is only valid when auth.type is iap or service_account` | skip `Authorization` injection only on minting routes |
| `proxy.routes[i].auth.suppress_authorization requires auth.headers` | otherwise the minted token would be discarded |
| `proxy.routes[i].auth.credentials file not found: PATH` | IAP credentials file is missing |
| `proxy.routes[i].auth.credentials is not valid JSON: PATH` | credentials file is not JSON |
| `proxy.routes[i].auth.credentials has no refresh_token` | authorized_user file needs a refresh token |
| `proxy.routes[i].auth.credentials client_id does not match auth.client_id` | file belongs to a different OAuth client |
| `proxy.inspect_max_bytes must be a finite number >= 0` | negative or non-finite default inspect cap |
| `llm.capture_max_bytes must be a finite number >= 0` | negative or non-finite default LLM capture cap |
| `proxy.routes[i].inspect.max_bytes must be >= 0` | negative capture cap |
| `llm.sources[i].capture.max_bytes must be >= 0` | negative per-source capture cap |
| `llm.sources[i].capture.field_map is only valid on type: proxy` | field mapping is proxy-capture only |
| `llm.sources[i].capture.field_map.model must be a non-empty JSON path` | empty mapped path |
| `llm.sources[i].capture.field_map.model must start with $.request. or $.response.` | paths are evaluated against `{request, response}` |
| `proxy.routes[i].timeout.idle_ms must be a finite number >= 0` | negative or non-finite idle hop deadline |
| `proxy.routes[i].timeout.total_ms must be a finite number >= 0` | negative or non-finite total hop deadline |
| `services.X.logs.multiline.start is not a valid regular expression` | `start` / `continuation` must compile as a JS regex |
| `services.X.logs.multiline.max_wait_ms must be >= 0` | negative idle fold timeout |
| `services.X.logs.multiline.max_lines must be >= 0` | negative fold cap |
| `services.X.logs.dedupe_access_line must be a boolean` | present value is not `true`/`false` |
| `proxy.routes[i].log.grpc.ok[j].status must be a number` | each ok entry needs a numeric gRPC status |
| `proxy.routes[i].log.grpc.ok[j].status must be an integer from 1 to 16` | listed statuses are the non-zero gRPC codes |
| `proxy.routes[i].log.grpc.ok[j].log must be "info" or "silent"` | omit `log` for the info default |
| `proxy.routes[i].inspect.grpc.decoder must be a registered plugin traffic decoder` | named decoder with `plugins:` empty |
| `proxy.listen.port is required when proxy.enabled is true` | pin a port |
| `unsupported config version N (expected 1)` | `version:` must be `1` |
| `unknown fields: services.a.depends_on` | not in the allowlists at the top of this file — usually a compose or k8s spelling |

Every message above is the validator's exact wording. `devctl config validate`
prints one per line and exits 2; a clean run prints `configuration is valid`
and exits 0.
