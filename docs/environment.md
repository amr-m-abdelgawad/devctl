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
| `process` | The env of whichever CLI/TUI client most recently started or restarted this service (forwarded over the RPC as `client_env`), falling back to the supervisor's own environment if no client has done so yet — see below |
| `profile` | `profiles.<name>.environment` |
| `dotenv` | Repo-root then service working-dir: `.env`, `.env.development`, `.env.local`, `.env.<profile>` |
| `generated` | Built-in hook that always returns `{}`. A plugin may register `environmentSources` if you need generated values |
| `keychain` | Named secrets from `environment.secrets` / the credential store |
| `secret_manager` | Values that look like `projects/*/secrets/*` via the Google REST API |
| `defaults` | `services.<name>.environment.defaults` |
| `vars` | Explicit `services.<name>.environment` keys |
| `runtime` | Values `devctl` injects at start |

`keychain` and `secret_manager` throw only when that source is listed and fetch fails.

### `process` and the daemon-replacement limitation

The daemon remembers each service's `client_env` only in memory, per service, never on disk. A crash/health-triggered auto-restart or an MCP-initiated `start`/`restart` reuses the last one a real client supplied; a service that has never been started/restarted by a real client this daemon's lifetime — e.g. one adopted from a prior session by `recoverSession()` — has none, and falls back to the daemon's own (possibly stale) environment.

This memory does not survive the daemon process itself being replaced (upgrade, crash, `devctl down` then a fresh start): a new daemon starts with no client history at all, so anything it restarts before a client issues a fresh `start`/`restart` runs on whatever environment that new daemon process itself inherited at spawn. If a service depends on env that changed since the daemon last started, restart it explicitly (`devctl restart <service>` or the TUI) rather than relying on an automatic restart to pick it up.

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
