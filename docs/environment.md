# Environment

Each service process gets a merged environment. Later sources override earlier ones.

Default source order (`ENV_SOURCE_ORDER` / `environment.sources`):

```mermaid
flowchart LR
  process --> profile --> dotenv --> generated --> keychain --> secret_manager --> defaults --> vars --> runtime
```

`process`, `defaults`, `vars`, and `runtime` always run. If you set `environment.sources`, the listed optional sources (`profile`, `dotenv`, `generated`, `keychain`, `secret_manager`) are added to that always-on set.

| Source | What it loads |
|--------|----------------|
| `process` | The supervisor’s own environment |
| `profile` | `profiles.<name>.environment` |
| `dotenv` | Repo-root then service working-dir: `.env`, `.env.local`, `.env.development`, `.env.<profile>` |
| `generated` | Built-in hook that always returns `{}`. A plugin may register `environmentSources` if you need generated values |
| `keychain` | Named secrets from `environment.secrets` / the credential store |
| `secret_manager` | Values that look like `projects/*/secrets/*` via the Google REST API |
| `defaults` | `services.<name>.environment.defaults` |
| `vars` | Explicit `services.<name>.environment` keys |
| `runtime` | Values `devctl` injects at start |

`keychain` and `secret_manager` throw only when that source is listed and fetch fails.

## Runtime-generated variables

Injected when applicable:

- `SERVICE_PORT`, `SERVICE_HOST`
- `DEVCTL_PROXY_URL`
- `DEVCTL_SERVICE_NAME`
- `DEVCTL_ENVIRONMENT`
- `DEVCTL_TOKEN_URL` and `DEVCTL_INTERNAL_TOKEN` (never a raw access token)

References such as `${services.identity.ports.http}` resolve before process start, including inside profile and dotenv values.

`environment.required` on a service fails start if those keys are still empty after the merge.

## TUI / CLI flag precedence

```mermaid
flowchart LR
  cli["CLI flags"] --> env["DEVCTL_* env"]
  env --> tuiEnv["DEVCTL_TUI_CONFIG"]
  tuiEnv --> tuiJson["repo / user tui.json"]
  tuiJson --> yaml["repo .devctl"]
  yaml --> defaults["defaults"]
```

## File plugins

`plugins[].path` is a JS/TS module imported when the supervisor starts. It may export any of: `environmentSources`, `healthChecks`, `identityProviders`, `tokenProviders`, `logParsers`, `proxyMiddleware`. The built-in `generated` source stays empty unless you register an environment source.

## Related

- [Services](services.md)
- [Configuration](configuration.md)
- [Security](security.md)
