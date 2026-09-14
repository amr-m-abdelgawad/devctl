# Identity and proxy

Google is optional. Local-only services never construct a requirement on ADC. When identity *is* configured, user identity and service-account identity are separate paths that must not substitute for each other.

User-facing behavior: [authentication.md](../authentication.md), [impersonation.md](../impersonation.md), [iap.md](../iap.md), [proxy.md](../proxy.md), [http.md](../http.md). This page is the code.

## Detection and login (client or daemon)

`adapters/google/google.ts`:

- `detectGoogle(project)` → `GoogleStatus` (gcloud binary, ADC, email, project id + **source**: config / gcloud / ADC / env)
- `loginGoogle` / `logoutGoogle` shell out to gcloud ADC login

Doctor uses the same probes with more IAM/API granularity (`adapters/doctor/doctor.ts`).

## Token manager

`adapters/google/token.ts` `TokenManager`:

- Key: identity + audience + scopes (+ optional OAuth client override)
- `get` / `refresh` / `invalidate`
- Refresh if `expires_at - now < threshold` (`auth.refresh_threshold_seconds`)
- **Single-flight** per key so a burst of proxy requests cannot stampede IAM
- Providers from `googleTokenProviders()`: user access token, SA impersonation (`iamcredentials.generateAccessToken`), IAP identity token (audience required)

`IdentityCoordinator` holds the cache shown in the Auth/Credentials screens (email, SA availability tri-state `unknown | available | unavailable`). `auth_refresh` probes SAs via `tokens.refresh` and **must not** `invalidate()` the whole store first (that wiped unrelated IAP route credentials).

## Blocking start

`domain/identity/identity.ts` `identityBlockers(cfg, names, adcAvailable)`: services with `identity.type` / mode that need Google fail closed with a clear message; siblings still start. Orchestrator calls this after planning.

## Environment injection (no raw tokens by default)

`EnvironmentBridge` adds, for **host** processes when configured:

- `DEVCTL_PROXY_URL`
- `DEVCTL_TOKEN_URL` + `DEVCTL_INTERNAL_TOKEN` (loopback token endpoint)
- `DEVCTL_USER_EMAIL` when known
- `DEVCTL_HTTP_<NAME>_URL` for exposed recipes

Containers omit token URL/internal token (they cannot reach host loopback). Prefer proxy/recipe URLs over stuffing bearer tokens into env.

## Proxy

`ProxyCoordinator` + `ProxyServer`:

- Bind `proxy.listen` (must be loopback; tests in `security.test.ts`)
- **Lazy start**: supervisor boot does not bind. First `start()` auto-starts unless the user ran `proxy stop` (`suppressed`)
- Routes: hand-written `proxy.routes`, synthesized `expose` / `proxy.gateway`, synthesized `http.*.expose`
- HTTP/1.1 listener matches `host` + `path`
- `transport: grpc` → dedicated h2c listener (`grpc-proxy.ts`)
- Auth types: none, IAP, service_account impersonation, plugin/OIDC
- Inject `Authorization` (and optional `auth.headers` with `${token}`)
- CORS: `response_headers`; OPTIONS preflight answered locally
- Logs: method, path, route, identity, status, duration, request id — never the bearer
- `X-Devctl-Request-ID` generated or propagated; traces via `adapters/proxy/tracing.ts`

Upstream may be a fixed URL **or** `service` + `port` name resolved at request time (so auto ports follow restarts).

## Token endpoint

Separate bind (`proxy.token_endpoint`). `GET /token` requires the internal secret. Used by SDKs that cannot talk to the reverse proxy. Still loopback-only.

## HTTP recipes

`RecipeRuntime` (`adapters/http/runtime.ts`):

- Outbound HTTP with the same auth story as routes
- Cache: TTL (`expires_in`) and/or JWT `exp`
- Outputs: JSON paths + reserved `body` / `url` / `status`
- `${http.name.output}` in service env; implicit dependency so the recipe’s needed service is in the start plan (`domain/http/recipes.ts`)
- Optional expose: proxy returns the cached body at `name.local`

## Plugins

Generic OIDC client-credentials lives as a reference plugin (`adapters/plugins` tests). File plugins may register `IdentityProvider` / `TokenProvider` / `ProxyMiddleware`. Unknown `identity.type` or route `auth.type` after plugin load is a validation error, not a silent skip.

## Security invariants (code locations)

| Invariant | Where enforced |
|-----------|----------------|
| No SA JSON keys as the default path | Token providers; doctor copy |
| Loopback bind | `domain/net/hosts.ts` + proxy/MCP/web `listen` |
| Redact tokens in logs | `Detector`, proxy logger, MCP tools |
| `config_snapshot` not on MCP | Supervisor `dispatch` vs `tools.ts` |
| Compare secrets in constant time | `shared/bearer.ts` |
