# Plugins

Plugins extend devctl without changing the supervisor. A plugin is a JavaScript or TypeScript module loaded from `plugins[].path` when the supervisor starts. Relative paths are resolved from the repository root.

```yaml
version: 1
plugins:
  - path: ./plugins/team/index.ts
```

Every plugin must export the current SDK version as a named export. The current version is `1`.

```ts
import { PLUGIN_SDK_VERSION } from "../../app/src/plugin-sdk.ts";

export const sdkVersion = PLUGIN_SDK_VERSION;
```

An incompatible, malformed, or throwing plugin is skipped and reported in the devctl log instead of crashing the daemon. Configuration that depends on an extension from the skipped plugin still fails with a focused “unknown …” error; devctl never silently ignores an unknown health check, identity type, or environment source.

## Extension points

A module may export any combination of these named arrays:

| Export | Required shape | Purpose |
|--------|----------------|---------|
| `environmentSources` | `{ name, load(ctx) }` | Add values to a service environment |
| `healthChecks` | `{ name, check(config, ctx) }` | Implement a custom health-check type |
| `identityProviders` | `{ name, accepts(config), resolve(config, detect) }` | Resolve custom service identities |
| `tokenProviders` | `{ name, accepts(identity), fetch(identity, audience, scopes) }` | Mint and refresh access tokens |
| `logParsers` | `{ name, parse(line) }` | Parse service log lines |
| `proxyMiddleware` | `{ name, apply(ctx) }` | Participate in proxy request handling |

The TypeScript contracts and SDK constant are exported by [`app/src/plugin-sdk.ts`](../app/src/plugin-sdk.ts). A plugin must export arrays, each entry must have a non-empty `name`, and the methods shown above must be functions. Keep plugin startup code small: top-level exceptions cause the whole module to be skipped.

## Custom identity configuration

`services.<name>.identity.config` is an opaque object passed unchanged to the selected identity provider. devctl owns `type`; the plugin owns the keys under `config`.

```yaml
services:
  api:
    command: [bun, run, src/api.ts]
    identity:
      type: my_provider
      config:
        tenant: development
```

An identity provider can return a stable `tokenKey`. Token providers use that key to recognize the identity, cache tokens, and refresh them safely.

## Generic OIDC reference plugin

The repository includes [`plugins/oidc/index.ts`](../plugins/oidc/index.ts), a generic OAuth 2.0 client-credentials provider with OpenID Connect discovery.

```yaml
version: 1
plugins:
  - path: ./plugins/oidc/index.ts

services:
  api:
    command: [bun, run, src/api.ts]
    identity:
      type: oidc
      config:
        issuer: https://identity.example.com
        client_id: local-api
        client_secret_env: DEVCTL_OIDC_CLIENT_SECRET
        scopes: [api.read]
        audience: https://api.example.com
```

The plugin discovers `token_endpoint` from `<issuer>/.well-known/openid-configuration`. Set `token_endpoint` explicitly to bypass discovery. `scopes` may be an array or a space-separated string, and a caller-provided audience or scope list takes precedence over the configured defaults.

Prefer `client_secret_env` and supply the secret through your shell, keychain, or secret manager. Inline `client_secret` is supported for local experiments but places a credential in the repository configuration. The reference plugin keeps resolved configuration only in memory and never writes tokens or secrets to disk.

The OIDC plugin is intentionally a reference implementation: it supports client credentials, not browser login, authorization code, device code, refresh-token persistence, or provider-specific claims.

## Operational notes

- Plugin code runs inside the supervisor process and receives the same permissions. Only load code you trust.
- Changing plugin code requires restarting the supervisor; configuration reload does not unload imported module state.
- A configured plugin path must exist. Invalid or missing paths are rejected during configuration validation.
- Unknown custom environment sources, health types, and identity types are errors after plugins load.

## Related

- [Configuration](configuration.md)
- [Environment](environment.md)
- [Authentication](authentication.md)
- [Security](security.md)
