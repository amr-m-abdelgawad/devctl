# Service account impersonation

Preferred flow:

```mermaid
flowchart LR
  user["Developer Google identity"] --> iam["IAM Credentials API<br/>generateAccessToken / generateIdToken"]
  iam --> sat["Short-lived service account token"]
```

Developers need `roles/iam.serviceAccountTokenCreator` on each target service account (preferably bound via a Google Group). `devctl` never downloads or stores service-account private keys.

```yaml
identity:
  type: service_account
  service_account: worker-dev@company-dev.iam.gserviceaccount.com
```

`type: service` is accepted as an alias for `service_account`.

If impersonation is unavailable, **that** service fails to start. Unrelated local services still run.

When a proxy route uses `auth.type: iap` and a service-account identity, `devctl` calls IAM Credentials `generateIdToken` for that account (never a user ID token). Access tokens without an audience still use `generateAccessToken`.

Probing a configured SA is lazy and cached, never automatic: it happens the first time a service actually starts under that identity, on an explicit `auth_refresh`, or on a doctor inspection — never on the daemon's own boot or after a reload, which only ever refresh ADC/user/project. Status is one of `unknown` (not probed yet), `available`, or `unavailable`; doctor and the TUI's Auth screen render "not probed yet" distinctly from a confirmed failure rather than treating it as unavailable. Organization policies that disable impersonation or constrain ADC look like IAM failures — confirm those before changing developer machines. See [Admin setup](admin-setup.md).

## Related

- [Authentication](authentication.md)
- [IAP](iap.md)
- [Proxy](proxy.md)
- [Security](security.md)
