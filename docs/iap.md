# Identity-Aware Proxy

IAP routes must set an audience (IAP OAuth client ID or IAP resource name) **and** an identity. A missing `identity.type` is a configuration error, not a silent default to the current user.

```yaml
auth:
  type: iap
  audience: "/projects/PROJECT_NUMBER/iap_web/..."
  identity:
    type: user
```

or

```yaml
auth:
  type: iap
  audience: "..."
  identity:
    type: service_account
    service_account: backend-dev@company-dev.iam.gserviceaccount.com
```

User identity mints an ID token with ADC's default OAuth client. To mint with a **specific** OAuth client instead (a Desktop client, or the IAP client's own ID), set `client_id` and `client_secret`. Put `${NAME}` or `${env.NAME}` in `client_secret` so the value is read from the process environment **or** gitignored `.devctl/secrets.env` (weaker: `~/.devctl/secrets.env`) at mint time — that is not the same as service-env `${services…}` interpolation, which does not run on route auth. Process env still wins. There is no `${secret:}` syntax:

```yaml
auth:
  type: iap
  audience: "IAP_CLIENT_ID.apps.googleusercontent.com"
  identity:
    type: user
  client_id: "DESKTOP_CLIENT_ID.apps.googleusercontent.com"
  client_secret: "${IAP_OAUTH_CLIENT_SECRET}"
```

Omit `client_id` to keep the default ADC client. `client_id` is only valid on `auth.type: iap` with `identity.type: user`. Service-account IAP still uses IAM `generateIdToken` against `audience`.

The ADC refresh token must have been issued to that OAuth client. `gcloud auth application-default login` uses the Cloud SDK client by default; a mismatch fails as `unauthorized_client`. Login with a client secret file that matches `client_id`, or omit `client_id`.

When a route (or `proxy.credentials`) points at a separate authorized_user file, `devctl config validate` checks that the file exists, is JSON with `refresh_token` and `client_id`, and that the file's `client_id` matches the route. `devctl status` reports that result as `credentials_valid` on the route snapshot (`true` / `false` when a file is configured; omitted otherwise). `devctl doctor` reports the same inspect as `IAP credentials <route>` even when a live mint is skipped (for example a missing audience). A missing or mismatched file is an error and hints `gcloud auth application-default login` with a client secret file that matches `client_id` (or omit `client_id`); TUI `/auth login` or `devctl auth login`.

```mermaid
flowchart LR
  client["Local client"] --> proxy["devctl proxy"]
  proxy --> ident{"Route identity"}
  ident -->|user, default client| adc["ADC user ID token"]
  ident -->|user, client_id| oauth["UserRefreshClient ID token"]
  ident -->|service_account| iam["IAM generateIdToken"]
  adc --> iap["Google IAP"]
  oauth --> iap
  iam --> iap
  iap --> up["Upstream"]
```

The local proxy mints the token and injects `Authorization: Bearer …`. Services do not implement IAP themselves.

Tokens refresh when `expires_at - now < auth.refresh_threshold_seconds` (default 300). Concurrent refreshes for the same identity + audience + scope + OAuth client share one in-flight request. Google minting is also capped at 10 refreshes per identity and audience per minute.

Doctor probes IAP audiences (including SA impersonation and a configured OAuth client) even if the rest of the repo looks local-only. The credentials-file inspect above is static and does not require network.

Local demos can use `auth.type: none` so routes still appear in the proxy screen without calling real IAP.

## Related

- [Proxy](proxy.md)
- [Impersonation](impersonation.md)
- [Authentication](authentication.md)
- [Admin setup](admin-setup.md)
