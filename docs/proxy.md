# Proxy

The local proxy injects authentication so services do not each implement Google/IAP logic. It runs **inside the supervisor**.

Default listen address when enabled: `127.0.0.1:8080`. Binding to `0.0.0.0` is rejected. The demo platform uses `127.0.0.1:18080`.

```bash
devctl proxy start
devctl proxy status
devctl proxy stop
```

The TUI **proxy** tab (`p`) shows status, routes, and a live log of recent requests. `n` starts, `x` stops. SA email is shown when a route uses one.

Each request gets `X-Devctl-Request-ID` — propagated from the caller if it sent one, generated otherwise — and it's echoed back on the response so a caller can find its own request in the log below. Proxy logs never include `Authorization` headers. Bodies are streamed.

WebSocket upgrades use the same route matching, identity injection, middleware, request logging, and statistics as ordinary HTTP traffic (HMR and other upgraded connections behind a route). Active upgraded sockets are closed during proxy shutdown so `devctl down` cannot hang.

If `proxy.enabled` is true, `devctl start` also starts the proxy.

## Routes

```yaml
proxy:
  enabled: true
  listen:
    host: 127.0.0.1
    port: 8080
  routes:
    - name: invoices-api
      match:
        host: invoices-api.local
        path: ""
      upstream:
        url: http://127.0.0.1:18000
      auth:
        type: none          # none | iap | service_account
        identity: user      # or { type: service_account, service_account: email }
```

Match is host + optional path prefix.

### Per-service routes

Optional `proxy` on a service is one route fragment or a list. At load they append to the **same** global `proxy.routes` list with stable names (`<service>` or `<service>-<n>`). Duplicate names fail validation. Runtime stays one listener.

```yaml
services:
  api:
    command: python main.py
    proxy:
      - match:
          path: /api
        upstream:
          url: http://127.0.0.1:8000
```

## Token endpoint

Optional `GET /token` (`proxy.token_endpoint`) binds to `127.0.0.1` (never `0.0.0.0`), requires `X-Devctl-Internal-Token`, and only accepts loopback peers.

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "expires_at": "2026-08-30T00:05:00.000Z",
  "identity": "user"
}
```

Managed processes receive `DEVCTL_TOKEN_URL` (rewritten to the bound port after listen) and `DEVCTL_INTERNAL_TOKEN`, not raw tokens in the environment.

## Live request log

The proxy keeps the last 100 requests in memory — method, path, matched route (blank for a request that matched no route, still logged as a 404), identity key used, status, duration, and request id — and reports a running total/error count alongside them. This is part of the regular status snapshot, so it updates the same way everything else in the TUI does: the moment a request refreshes a token or hits a route, the **proxy** tab reflects it without pressing `r` or restarting anything.

Paths are redacted the same way response header values already are, since a query string can carry secrets. Nothing here is persisted — it's an in-memory ring buffer, reset on daemon restart.

## Request flow

```mermaid
flowchart TB
  client["Local client"] --> listen["127.0.0.1:proxy"]
  listen --> match["Match route: host + path prefix"]
  match --> ident{"identity.type"}
  ident -->|user| adc["Application Default Credentials"]
  ident -->|service_account| sa["Impersonated SA token"]
  adc --> auth{"auth.type"}
  sa --> auth
  auth -->|iap| iap["IAP ID token for audience"]
  auth -->|none| inject
  auth -->|service_account| satoken["OAuth access token for the SA"]
  satoken --> inject
  iap --> inject["Inject Authorization + X-Devctl-Request-ID"]
  inject --> up["Stream to upstream.url"]
```

A missing `identity.type` on an IAP route is a configuration error.

## Related

- [IAP](iap.md)
- [Impersonation](impersonation.md)
- [Security](security.md)
- [TUI](tui.md)
