# demo-platform

A local-only example, modeled as a small invoicing platform, used by tests and the TUI walkthrough. No Google Cloud is required. Proxy routes show identity labels without calling real IAP.

| Service | Stack | Port | Role |
|---|---|---|---|
| `identity` | Python 3 (stdlib `http.server`) | 18001 | session login / whoami |
| `invoices-api` | Python 3 | 18000 | invoice job queue; calls identity |
| `invoices-worker` | Python 3 | 18002 | polls invoices-api and finalizes jobs |
| `billing-console` | React + Vite (Bun) | 18003 | admin console UI |

Profiles: `minimal` (identity + api), `backend` (+ worker), `full` (+ console). Config is modular under `.devctl/`.

```bash
# python3 and bun on PATH
cd examples/demo-platform
bun run ../../app/src/bin.ts                 # TUI
bun run ../../app/src/bin.ts config validate
bun run ../../app/src/bin.ts start --profile full --detach
bun run ../../app/src/bin.ts status
# Billing console UI: http://127.0.0.1:18003
# Proxy: 127.0.0.1:18080
bun run ../../app/src/bin.ts mcp --on        # optional agent URL
bun run ../../app/src/bin.ts stop
```

The first `billing-console` start runs `bun install` in `billing-console/` if `node_modules` is missing.

`devctl start` with no profile starts **all four** services (same as MCP `start_services` with no names). Use `--profile backend` to match the usual three-process set.

Each Python service logs at `INFO`/`WARN`/`ERROR` (session churn, rejected requests, unreachable dependencies, retry/backlog) so the logs and status screens have something realistic to filter.

Wiki: [docs](../../docs/README.md).
