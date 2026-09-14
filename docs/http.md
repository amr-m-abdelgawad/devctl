# Custom HTTP APIs

Named outbound HTTP **recipes** under `http:` construct a request from a template, cache the response, interpolate pieces into other config, and optionally expose the cached body as a local proxy endpoint.

This is not a reverse-proxy route. [`proxy.routes`](proxy.md) **forward** a caller’s request and inject IAP. A recipe is an outbound call the supervisor makes: mint tokens, POST form bodies, parse JSON, cache until expiry, then inject results.

```mermaid
flowchart TB
  yaml["http.login in .devctl"] --> validate[Load and validate]
  validate --> start[Service or task start]
  start --> implicit[Start implicit service deps]
  implicit --> ensure["RecipeRuntime.ensure(login)"]
  ensure --> mint["TokenManager.get for recipe auth"]
  mint --> call[Templated outbound HTTP]
  call --> cache[In-memory JWT-aware cache]
  cache --> env["Interpolate ${http.login.token} into env"]
  cache --> route["Synthesized proxy route login.local"]
  env --> proc[Spawn process]
  route --> live["Later GET still returns fresh/cached body"]
```

CORS applies on the **inbound** synthesized route (browser preflight), same as proxy `response_headers`. Auth applies on the **outbound** recipe (IAP / SA / extra headers), same as a proxy route’s `auth` block.

## Config

Top-level map `http`. Modular files: `.devctl/http/<name>.yaml` (filename is the recipe name), same pattern as `services/`.

```yaml
http:
  idp-token:
    request:
      method: POST
      url: https://idp.example.com/oauth/token
      headers:
        Content-Type: application/json
        X-User: ${identity.user}
      body: '{"grant_type":"client_credentials"}'
      auth:
        type: iap
        audience: "/projects/x/iap/xxx"
        identity: user
        headers:
          identity-token: "${token}"
      timeout_seconds: 10
    outputs:
      token: access_token
      expires_in: expires_in
    cache:
      jwt: true
      expires_in: expires_in
    expose:
      enabled: true
      host: idp-token.local
      response_headers:
        Access-Control-Allow-Origin: "*"
        Access-Control-Allow-Methods: "GET, OPTIONS"
        Access-Control-Allow-Headers: "Authorization, Content-Type, X-Devctl-Request-ID"

services:
  invoices-api:
    environment:
      IDP_TOKEN: ${http.idp-token.token}
      IDP_TOKEN_URL: ${http.idp-token.url}
```

`form:` is an alternative to `body:` — encoded as `application/x-www-form-urlencoded`. You cannot set both.

**Reserved output names:** `body` (raw response text), `url` (local expose URL), `status`. Named `outputs` must not use those.

`${http.name.body}` is always the raw body. A dotted path that lands on an object or array is serialized as JSON text.

`${token}` in the recipe `url` / `headers` / `form` / `body` is the token minted for **that recipe’s** `auth` block. Recipes with `auth.type: none` cannot use `${token}`.

`auth.type: iap` / `service_account` still mint a token for `${token}`, but do **not** set `Authorization: Bearer …` when the recipe already sets `request.headers.Authorization` (Apigee wants `Basic client_id:secret` on the token endpoint, with the Google ID token in `subject_token`). If `Authorization` is unset, Bearer injection matches today’s proxy behavior.

**Allowed refs inside a recipe request** (resolved at fetch time): `${services.*}`, `${identity.user}`, `${token}`, `${http.<other>.<output>}`. Recipe `url` / `headers` / `form` / `body` also expand `${NAME}` / `${env.NAME}` from the **supervisor process environment** so secrets like `client_secret` can live in the shell or keychain overlay, not in git. Service env still rejects `${env.NAME}`.

Load-time validation checks shape and names only (unknown recipe/output, cycles, reserved names, expose requires `proxy.enabled`). Values are not expanded until `ensure()`.

Unknown fields are rejected.

## Consumption

1. **Env / config interpolation** — `${http.<name>.<output>}` in service/task/profile env. The daemon calls `ensure()` **before** spawn so the snapshot is populated. A running process does not see later refreshes (same as today’s port refs).
2. **Live local endpoint** — `expose.enabled: true` synthesizes a proxy route (auth `none` inbound). Any non-preflight request returns the **full cached recipe response** (status, content-type, body). CORS preflight is answered locally and does **not** trigger the outbound call.

When a recipe is exposed, host services also get `DEVCTL_HTTP_<NAME>_URL` (uppercase, hyphens → underscores), analogous to `DEVCTL_TOKEN_URL`. Containers skip it for the same loopback reason as the token endpoint.

Recommend JWT consumers: put the snapshot in env **and** poll/read `${http.name.url}` when they need a fresh token.

## Cache

Refresh window is always `auth.refresh_threshold_seconds` (default **5 minutes**). At least one of `cache.jwt` / `cache.expires_in` must be set to enable caching; otherwise each `ensure()` / expose hit refetches.

- `cache.jwt: true` — scan string outputs plus common fields (`access_token`, `id_token`, `token`) for JWT `exp`. Fail the fetch if none found.
- `cache.expires_in: expires_in` — dotted path to OAuth `expires_in` **seconds**. Expiry = now + that many seconds. Fail if the field is missing or not a positive number.
- Both set: TTL is the **earlier** of JWT `exp` and `expires_in`.

Lazy refetch inside the window; proactive timer about 5 minutes before expiry; in-flight coalescing; memory only. A failed refresh keeps the last valid body until expiry, then consumers fail.

## Startup ordering

Starting a service (or running a task) that references `${http.*}`:

1. Walk those recipes (and chained recipes) for `${services.*}`.
2. Start those local services first (`service_healthy` when they define a health check, else `service_started`).
3. After ports are assigned, `ensure()` the recipes, then snapshot env and spawn.

Recipe-to-recipe cycles fail `devctl config validate`. Fetch failure blocks start (same class as a missing `environment.required` key).

## Apigee token exchange

Typical flow: POST form-urlencoded to an Apigee `GenerateAccessToken` proxy with RFC 8693-style params. Request:

- `Authorization: Basic <client_id:client_secret>`
- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (or `password` / `client_credentials` / `assertion`, depending on the proxy)
- `subject_token=${token}` — Google user or SA **ID token** minted by TokenManager
- `subject_token_type=urn:ietf:params:oauth:token-type:id_token`

Response is usually JSON `{ access_token, token_type, expires_in }` where `access_token` is **opaque**, not a JWT. Cache from `expires_in`, not JWT `exp`.

```yaml
http:
  apigee-token:
    request:
      method: POST
      url: https://api.company.com/v1/oauth/token
      headers:
        Authorization: "Basic ${APIGEE_BASIC}"
      form:
        grant_type: urn:ietf:params:oauth:grant-type:token-exchange
        subject_token: ${token}
        subject_token_type: urn:ietf:params:oauth:token-type:id_token
      auth:
        type: iap
        audience: IAP_OR_GOOGLE_AUD
        identity: user
    outputs:
      token: access_token
    cache:
      expires_in: expires_in
    expose:
      enabled: true
```

Consumers: `APIGEE_TOKEN: ${http.apigee-token.token}` at start, and `${http.apigee-token.url}` / `DEVCTL_HTTP_APIGEE_TOKEN_URL` for refresh.

If the token URL itself is behind IAP, omit `headers.Authorization` so Bearer is injected instead of Basic.

v1 does not mint two different audiences on one recipe (IAP Bearer for the hop **and** a different-audience Google token in `subject_token`). Workaround: token URL not behind IAP (the usual Apigee pattern), or two recipes.

## Related

- [Proxy](proxy.md)
- [Environment](environment.md)
- [Configuration](configuration.md)
- [IAP](iap.md)
