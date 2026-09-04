# demo-platform

A mostly local example, modeled as a small invoicing platform, used by tests and the TUI walkthrough. Starting the host services requires no Google Cloud and no Docker. Three `invoices-worker-*` proxy routes are opt-in credential examples — plain service-account impersonation, IAP for the developer's own identity, and IAP on top of impersonation; calling any of them, probing them with Doctor, or running `invoices-worker`'s own token-watch loop requires Google ADC and permission to impersonate the configured account.

| Service | Stack | Port | Role |
|---|---|---|---|
| `identity` | Python 3 (stdlib `http.server`) | 18001 | session login / whoami |
| `invoices-api` | Python 3 | 18000 | invoice job queue; calls identity |
| `invoices-worker` | Python 3 | 18002 | polls invoices-api, finalizes jobs, watches its own token |
| `billing-console` | React + Vite (Bun) | 18003 | admin console UI |
| `telemetry` | Python 3 | — | background agent; no HTTP, JSON-per-line logs (see below) |
| `postgres` | Docker (`postgres:16`) | 18004 | opt-in data profile; not in the default profiles |

Profiles: `minimal` (identity + api + telemetry), `backend` (+ worker), `full` (+ console), `data` (postgres only; needs Docker). Config is modular under `.devctl/`. `devctl run migrate` is a one-off task that starts postgres first.

`postgres` is always in configuration, so Doctor still probes Docker even when you never start `data`. Default profiles do not start it.

```bash
# Node.js 18+ (npm package) or python3 and bun on PATH (from source)
cd examples/demo-platform
npx @amr-m-abdelgawad/devctl@latest          # TUI
```

From a source checkout:

```bash
cd examples/demo-platform
bun run ../../app/src/bin.ts                 # TUI
bun run ../../app/src/bin.ts config validate
bun run ../../app/src/bin.ts start --profile full
bun run ../../app/src/bin.ts status
# Billing console UI: http://127.0.0.1:18003
# Proxy: 127.0.0.1:18080
bun run ../../app/src/bin.ts mcp --on        # optional agent URL
bun run ../../app/src/bin.ts stop
```

`devctl start` with no profile starts **backend** — the first profile name alphabetically (`backend`, `data`, `full`, `minimal`), same as MCP `start_services` with no names. It never starts every service. Pass `--profile full` for the console, `--profile data` for postgres.

## Credential, IAP, and identity patterns

`invoices-api` and `billing-console` route with `auth: none` — no Google Cloud needed. Everything else lives behind `invoices-worker` (port 18002), reachable through three proxy hosts that each demonstrate a different auth pattern against the *same* upstream, so the only variable between them is the injected header:

| Route | Host | Pattern | What gets minted |
|---|---|---|---|
| `invoices-worker-impersonation` | `invoices-worker-sa.local` | plain service-account impersonation (`auth.type: service_account`) | a real OAuth **access token** for the impersonated account, no IAP |
| `invoices-worker-iap-user` | `invoices-worker-user.local` | IAP for the developer's own identity | a real IAP **ID token** for the signed-in developer, no impersonation |
| `invoices-worker-api` | `invoices-worker.local` | IAP on top of impersonation | a real IAP **ID token** for the impersonated account |

Start the backend profile and hit all three the same way:

```bash
gcloud auth application-default login
bun run ../../app/src/bin.ts start --profile backend
bun run ../../app/src/bin.ts doctor            # confirms ADC + serviceAccountTokenCreator before you rely on any of this
bun run ../../app/src/bin.ts auth refresh
curl -i -H 'Host: invoices-worker-sa.local'   http://127.0.0.1:18080/health
curl -i -H 'Host: invoices-worker-user.local' http://127.0.0.1:18080/health
curl -i -H 'Host: invoices-worker.local'      http://127.0.0.1:18080/health
```

`-i` shows the response, not the request — check the Proxy screen (or `devctl status --json`) to see the `Authorization` header devctl actually injected for each. The checked-in audience (`https://invoices-worker.local`) is suitable for exercising local token minting. Replace it with the protected backend's real IAP OAuth client ID or IAP resource name before routing to Google IAP. The impersonated account (`invoices-worker-dev@company-dev.iam.gserviceaccount.com`, referenced from both `config.yaml` and `invoices-worker.yaml`'s `TOKEN_WATCH_*` variables) needs `roles/iam.serviceAccountTokenCreator` granted to the signed-in developer — `devctl doctor` reports this as AVAILABLE/UNAVAILABLE per account, so treat it as the setup gate rather than debugging a 502 blind. To point any of this at a real project, replace `google.project_id` in `config.yaml` and every occurrence of the placeholder account with your own — same string in all three places, so one find-and-replace across this directory covers it.

### Proving refresh actually happens, without waiting hours

The whole point of devctl's credential handling is that a developer never has to think about it during a long local session — tokens should keep quietly refreshing themselves in the background. That's awkward to verify literally (a real token lasts about an hour, so proving it survives *ten* would take ten hours), so this example ships with `auth.refresh_threshold_seconds: 3300` — deliberately close to a token's ~1hr lifetime. Once a token is more than 5 minutes old it falls inside that window, and the *next* request for it forces a fresh mint. In practice that means every request more than a few minutes apart re-mints, so a handful of curls a couple of minutes apart exercises exactly what a multi-hour session would:

```bash
curl -s -H 'Host: invoices-worker.local' http://127.0.0.1:18080/health >/dev/null
bun run ../../app/src/bin.ts status --json | jq '.credentials.entries[] | select(.identity | startswith("sa:"))'
# wait a couple of minutes, repeat — expires_at keeps moving forward on its own
```

Or just watch it happen without touching curl at all: `invoices-worker` polls devctl's token endpoint itself every 15s (`TOKEN_WATCH_IDENTITY`/`TOKEN_WATCH_AUDIENCE` in `invoices-worker.yaml`, requires `proxy.token_endpoint.enabled: true`, already on in this config) and logs `token watch: minted …` / `refreshed …` / `cached …` lines — visible in `devctl logs invoices-worker` or the Logs screen. That's the same `DEVCTL_TOKEN_URL` pattern a real service would use for its own outbound calls to Google APIs, rather than relying on the proxy to inject credentials inbound. Turn `refresh_threshold_seconds` back down toward the default (`300`) once you're done; a real session doesn't need every request re-minting.

The first `billing-console` start runs `bun install` in `billing-console/` if `node_modules` is missing.

Each Python service logs at `INFO`/`WARN`/`ERROR` (session churn, rejected requests, unreachable dependencies, retry/backlog) so the logs and status screens have something realistic to filter. `telemetry` is the exception: it emits one JSON object per line (`time`/`level`/`msg`/`request_id`, plus extra fields like `status` and `latency_ms`) instead of plain text — pino/zap-style structured logging — specifically to exercise the Logs screen's JSON parsing. Open its logs and the list shows a clean message and level like any other service; press enter (or click a row) to see the full record, extra fields included.

Wiki: [docs](../../docs/README.md).
