# demo-platform

A mostly local example, modeled as a small invoicing platform, used by tests and the TUI walkthrough. Starting the host services requires no Google Cloud and no Docker. Three `invoices-worker-*` proxy routes are opt-in credential examples — plain service-account impersonation, IAP for the developer's own identity, and IAP on top of impersonation; calling any of them, probing them with Doctor, or running `invoices-worker`'s own token-watch loop requires Google ADC and permission to impersonate the configured account.

| Service | Stack | Port | Role |
|---|---|---|---|
| `identity` | Python 3 (stdlib `http.server`) | 18001 | session login / whoami |
| `invoices-api` | Python 3 | 18000 | invoice job queue; calls identity; JSON access logs |
| `invoices-worker` | Python 3 | 18002 | polls invoices-api, finalizes jobs, watches its own token |
| `billing-console` | React + Vite (Bun) | 18003 | admin console UI |
| `telemetry` | Python 3 | — | log-shape / OTLP / trace showcase (see below) |
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
# Telemetry UI: http://127.0.0.1:18900
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

## Logs, traces, and OTLP

`identity` and `invoices-worker` still write plain `INFO name message` lines. Everything else in this example is there to make the new log model obvious:

| What you will see | Where it comes from | What to look for |
|---|---|---|
| Clean `msg` + `INFO`/`WARN`/`ERROR` | `telemetry` pino / zap / logrus / structlog / ECS | list line is human; extra fields are attributes (enter) |
| Level column shows **—** | `shape=no-severity` — JSON with `msg` and **no** `level`/`severity` | unspecified is a dash, not a fake INFO |
| `invoice_id=… amount_cents=…` logfmt, no braces | `shape=no-message-key` — object with no `msg`/`message`/`event` | the whole object is the body; details shows it as a table |
| `disk pressure…` with ERROR | `shape=gelf` — `short_message` + syslog `level: 3` | GELF numeric levels map |
| Timestamp stuck in front of `{` | `shape=prefixed` | leading timestamp is stripped, JSON still parsed |
| `GET /invoices 200 12ms` | `telemetry` access-log JSON and `invoices-api` HTTP lines | no `msg` key; method/path/status become the summary |
| `invoice.queue.depth gauge 7 jobs` | `shape=metric` | metric_name / value / unit |
| Source column `otlp` | POSTs to `telemetry.otlp` (`127.0.0.1:18418`) | lossless lane; same service name, different source |
| ◎ in the meta column | `shape=traced` plus OTLP logs/spans | row has a `traceId`; enter → **view trace** |
| `api_key` / `authorization` as `********` | `shape=nested-secret` | nested secrets are stripped before the TUI/MCP see them |

OTLP is **on** in this example (`telemetry.otlp.enabled`, port **18418**). Host services get `OTEL_EXPORTER_OTLP_ENDPOINT` injected. Every few ticks `telemetry` runs a full **invoice.fulfill** pipeline through the proxy (`GET invoices-api.local/fulfill` with a W3C `traceparent`). Open a ◎ row: the waterfall is ~15 spans across four services, not a two-span stub.

```
telemetry        invoice.fulfill                 ████████████████████████  ~95ms  ◀ server
telemetry          cache.lookup                  ██                            ●  cache.miss event
telemetry          policy.evaluate                 ████                        ●  overlaps the HTTP start
telemetry          GET invoices-api.local/fulfill    ████████████████          ▶  real HTTP
proxy              GET invoices-api /fulfill         ████████████████          ◀  same traceparent
invoices-api         GET /fulfill                    ███████████████           ◀  db + identity + pdf
invoices-api           db.invoice.lock               ███                       ●
invoices-api           GET identity/health               █████                 ▶
identity                 GET /health                     █████                 ◀  only when traced
identity                   session.store.lookup           ███                  ●
invoices-api           pdf.render                            █████             ●  two events
telemetry          billing.authorize                  ████████████████         ▶  parallel with HTTP
telemetry            stripe.charge                       ██████████            ▶  ERR every other trip
telemetry          queue.invoice.ready                              ██         ▲
telemetry          worker.invoice.render                             ███       ▼
```

What to look for in the overlay:

- Overlapping bars (`policy` vs HTTP start, `billing`/`stripe` vs the proxy hop, producer vs consumer).
- Kind glyphs: ◀ server, ▶ client, ● internal, ▲ producer, ▼ consumer.
- An occasional `stripe.charge` **ERR** in the middle of the tree (card declined + `exception` event). `api_key` / `authorization` on that span redact to `********`.
- Correlated logs under the inspector: cache miss, invoices-api db/pdf lines, identity session lookup, stripe, queue — same `trace_id`, matching `span_id` highlighted.
- Proxy tab: recent `invoices-api` `/fulfill` rows are the same traces — click one.

Doctor probes still hit `/health` with **no** `traceparent`, so identity and invoices-api stay fast. Restart `telemetry`, `invoices-api`, and `identity` after pulling this example so `/fulfill` and the nested OTLP spans are live.

### TUI

```bash
cd examples/demo-platform
bun run ../../app/src/bin.ts start --profile backend
bun run ../../app/src/bin.ts                 # Logs tab: filter telemetry
```

- Filter **telemetry**. Cycle `shape=` in search (`f`) — try `no-severity`, `no-message-key`, `nested-secret`, `traced`.
- Enter a row: attributes table, `level — (0)` on the no-severity lines, redacted secrets, `source otlp` on receiver lines.
- Enter again on a ◎ row (or click **view trace**): waterfall timeline, span inspector, correlated logs. `j`/`k` moves the selected span. Every other fulfill paints `stripe.charge` as `error`.
- Proxy tab: recent `invoices-api` `/fulfill` rows are the same traces — click one.

### CLI / MCP

```bash
bun run ../../app/src/bin.ts logs telemetry
bun run ../../app/src/bin.ts logs telemetry --json          # JSONL LogRecords
bun run ../../app/src/bin.ts logs --attribute shape=no-severity
bun run ../../app/src/bin.ts logs --source otlp
# copy a trace id from a traced row, then:
bun run ../../app/src/bin.ts logs --trace '<32-hex-id>'
```

MCP tools on the same session: `get_logs` (body / attributes / severity / traceId), `get_trace`, `trace_request`, `recent_errors`. `get_status` includes recent proxy requests with `trace_id`.

Wiki: [docs](../../docs/README.md).
