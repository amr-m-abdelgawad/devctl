# Troubleshooting

| Symptom | What to do |
|---------|------------|
| `gcloud` not installed | Install the Cloud SDK only if you need Google identity. Local-only services still run |
| ADC unavailable | `gcloud auth application-default login` then `devctl auth status` |
| Wrong project | Set `google.project_id` or check `gcloud config get-value core/project`. Identity shows the source |
| Permission denied | Ask an admin for the missing IAM role; `devctl doctor` names the resource |
| Cannot impersonate SA | Need `roles/iam.serviceAccountTokenCreator` on that service account (group binding preferred) |
| IAP authentication failure | Confirm audience, IAP client, and that the identity matches the route |
| Port already in use | Doctor lists the holder. Stop a leftover, or change config. Running your own services will also show as “in use” |
| Service crashes | Open Logs, filter `ERROR` (`e`), restart with `R` |
| Health check failure | Confirm the health URL/port; `process` checks only PID liveness |
| Proxy unavailable | `devctl proxy start` or enable `proxy.enabled`. Bind is `127.0.0.1` only |
| Token expired | Automatic refresh uses `auth.refresh_threshold_seconds`; run `devctl auth refresh`. Open Doctor if ADC itself expired |
| Token audience incorrect | Set `auth.audience` on the IAP route; Doctor flags missing audiences |
| IAP used a user token for an SA route | Confirm the route identity is `service_account`; Doctor probes impersonated IAP separately |
| Leftover process after crash | Reopen `devctl` — adopt only when pid + command + cwd + startTime match `~/.devctl/state/<hash>/state.json`. A port-only leftover is never attached |
| `devctl attach` fails | No supervisor. Use `devctl start` first; attach never starts one |
| `devctl status` looks empty | If the socket is down, status prints persisted state and exits 0 when nothing is running |
| Start exits 5 or 6 | 5 = spawn failed; 6 = health never passed. Doctor then Logs |
| `start` brought up extra services | Empty start uses the active or first profile, plus dependencies. Pass `--profile` or explicit names to stay narrower |
| TUI stale / not updating | TUI follows the event bus (20–50ms batch). Quit and let a new supervisor start if an old one is still listening |
| Reload needs a restart | `devctl reload` and `/reload` list services whose command, env, ports, or identity changed |
| Configuration invalid | `devctl config validate` — unknown fields, cycles, and missing refs fail closed. TUI `v` / `/buffer` validates before write |
| Config on disk is broken but the TUI still opens fine | Expected: it attached to an already-running daemon and is showing its `config_snapshot` (last-known-good), not a fresh reparse of the broken file. Fix the file and `/reload` |
| `devctl update` says unavailable | GitHub Releases API could not be reached. Update with `npm install --global @amr-m-abdelgawad/devctl@latest`, or use another [installation method](installation.md) |
| MCP agent cannot connect | Listener is off by default. `/mcp` or `devctl mcp --on`. URL is loopback only; snippets include the bearer token |
| `devctl: command not found` | Run `npm install --global @amr-m-abdelgawad/devctl`, then ensure npm's global binary directory is on `PATH`. See [Installation](installation.md) |
| Bundled Bun runtime was not installed | Reinstall the npm package without `--ignore-scripts`; Bun uses its install script to select the correct platform runtime |

Internal `devctl` logs appear in the Logs screen with source `devctl`.

## Related

- [Doctor](doctor.md)
- [Logs](logs.md)
- [CLI](cli.md)
- [How it fits together](overview.md)
