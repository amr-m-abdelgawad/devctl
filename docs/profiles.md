# Profiles

A profile is a named list of services plus optional extra environment.

```yaml
profiles:
  minimal:
    services: [identity, invoices-api]
  backend:
    services: [identity, invoices-api, invoices-worker]
    environment:
      LOG_LEVEL: DEBUG
  full:
    services: [identity, invoices-api, invoices-worker, billing-console]
```

```bash
devctl start --profile backend
```

The TUI **profiles** screen (`o` or `/profiles`) lists configured profiles. `enter` selects one and offers start. None are hard-coded.

Empty-dashboard `enter` uses the first profile name **alphabetically** when no session profile is set.

`devctl start` / MCP `start_services` with **no** profile and **no** names starts the active session profile, or the first configured profile (alphabetically). With no profiles it fails closed. Pass `--profile` or explicit names to stay on a subset. It never expands to every service just because the list was empty.

## Sessions

Per-repo state lives under `~/.devctl/state/<repoID>/`:

| File | Role |
|------|------|
| `state.json` | session id, profile, pid / command / cwd / startTime / ports |
| `devctl.lock` | supervisor lock (stale locks from dead PIDs are replaced) |
| `devctl.sock` | JSON-RPC socket for TUI, CLI, and attach (Unix) |
| `\\.\pipe\devctl-<repoID>` | Named pipe used instead of the socket on Windows |

A leftover `~/.devctl/sessions/<repoID>/` is migrated once.

A new supervisor **adopts** leftover processes only when pid + command + cwd + startTime still match. An empty cwd on either side is ignored. It never signals an unrelated PID. `SessionRecovered` is published when anything is adopted. Adopted processes keep health polling; stdout/stderr from before adopt are not captured. A port-only leftover is logged and shown in Doctor; it is not attached.

Override the home directory with `DEVCTL_HOME`.

## Related

- [Services](services.md)
- [How it fits together](overview.md)
- [CLI](cli.md)
