# Logs, telemetry, LLM inspector

Three related stores, one redaction story. User pages: [logs.md](../logs.md), [telemetry.md](../telemetry.md), [llm.md](../llm.md), [proxy.md](../proxy.md#inspect-bodies).

## Log store

Production daemon: `createDaemonLogStore` (`adapters/storage/worker-log-store.ts`).

- Prefers a **worker thread** (`log-worker.ts`, protocol in `log-worker-protocol.ts`) so high-volume stdout does not block RPC.
- Falls back in-process (`LogManager`) if the worker fails; logs a WARN. Compiled standalone binaries skip the worker (`Bun.isStandaloneExecutable`).
- Ring size: `logs.max_memory_events`.
- Optional persist under `logs.persistence.directory` (default `~/.devctl/logs`) with retention days and max sessions.

Ingest path:

```text
process stdout/stderr
  → ProcessManager onLine
  → Supervisor log()
  → LogStore.append (parse level, attributes, redaction markers)
  → Bus LogReceived
  → RPC event to clients (droppable under backpressure)
```

TUI/MCP **history** uses `logs_page` / `queryPage` (cursors in `domain/logs/pagination.ts`), not the event stream alone.

Filters: service, level, search/regex, source, since/until, request_id, trace_id, attribute key/value. Ingest copies `devctl.request_id` from a proxy hop onto a nearby service line that names the same method (50ms event-time and ingest-arrival match; candidates expire 50ms after ingest arrival of the first folded line; HTTP hops require a request-target). If the service line arrived first, the tagged record is re-emitted and persisted. Optional query-time `dedupeRequestId` then collapses those pairs after the page is fetched. Facets (`logs_stats`) are the cheap poll.

Parsers: built-in line parser + plugin `LogParser`. Python-literal and OTLP AnyValue decoders live in domain so MCP/TUI share them.

Export: `logs` RPC with `export` path, or client-side `writeLogExport`.

## Redaction

`adapters/secrets/detector.ts` + `domain/logs/redact.ts` + `shared/redaction.ts`. Markers include PASSWORD, TOKEN, SECRET, … plus `secrets.extra_markers` / `extra_patterns`. Name markers match as delimited tokens (`API_TOKEN`) so they do not fire on `prompt_tokens`, `token_type`, `page_token`, or `DEVCTL_TOKEN_URL`. A field named exactly `token` is masked only when the value looks like a credential. Objects are walked; numbers and booleans stay. `secrets.redact: false` makes the detector a no-op for new data. MCP and web redact at output with the same flag. Logs, LLM calls, and traffic inspector hops are redacted at ingest when the flag is on (irreversible). TUI `/reveal` unmasks service env and `/diff` only.

Never log `Authorization`. Proxy request logs are structured without header dumps.

## Traces

`SpanManager` (`adapters/storage/spans.ts`) stores spans keyed by W3C `trace_id`. Sources:

- Proxy hops (`adapters/proxy/tracing.ts`)
- OTLP receiver (`adapters/telemetry/otlp-http.ts`) when `telemetry.otlp.enabled`
- Service logs that carry `trace_id` / `span_id` attributes

RPC: `get_trace`, `trace_request` (from `X-Devctl-Request-ID`). MCP/web reuse the same queries with redacted attributes.

OTLP env injection: `domain/telemetry/otel-env.ts` so user services can export to the loopback receiver (`OTEL_EXPORTER_OTLP_ENDPOINT`, …). Design note: `design/telemetry-otel-model.md`.

## LLM inspector

`LlmCoordinator` drives configured `llm.sources[]`. Each `LlmSourceDriver` has a `mode`:

- **pull** (`litellm`, `adapters/llm/litellm.ts`): the coordinator polls spend logs on `poll_seconds` from a local LiteLLM service (or via a proxy route `via.route`).
- **push** (`proxy`, `adapters/llm/proxy-driver.ts`): the coordinator registers **no** timer and never resolves a management hop. Instead `ProxyCaptureSink` (`adapters/llm/proxy-capture.ts`) tees OpenAI-compatible completion bodies off a tagged proxy route (`via.route`), reassembles SSE, maps them (`proxy-capture-map.ts`), and upserts straight into the store. `capture.paths` adds extra POST JSON path substrings on that source; those are stored as raw HTTP pairs without SSE reassembly. The HTTP proxy depends only on the `LlmCaptureSink` port, so the proxy adapter never imports the llm package. `begin` may include the inbound TCP `peer` and starts caller lookup immediately; `finish` awaits it.

Plugins may register other `LlmSourceDriver`s (pull by default).

Store: `LlmCallManager` (ring + redact). List endpoints strip bodies (`stripLlmBodies`); `get_llm_call` returns one call for detail overlays. `caller` is the originating service when known (`domain/llm/caller.ts`): `X-Devctl-Service`, `x-litellm-metadata` / body `metadata.service`, loopback peer at `begin` → `adapters/process/peer-caller.ts` (injected into `ProxyCaptureSink`, not imported from llm), LiteLLM spend-log metadata / non-email `user`. A proxy source's `source` name is the tagged route; UIs label it `via`.

`capture.prompts` gates prompt/response retention (the push path applies `stripLlmBodies` itself, since it bypasses the coordinator); `capture.max_bytes` bounds a captured body; `capture.paths` lists extra proxy path substrings to capture as raw pairs. Poll interval: `poll_seconds` (default 5, pull only).

## Traffic inspector

HTTP and gRPC proxies tee bodies into `TrafficCallRing` via `TrafficCaptureSink` when `proxy.routes[].inspect.enabled` is true. The HTTP proxy may start both LLM and traffic tees and share one in-cap buffered request body. List endpoints strip bodies (`stripTrafficBodies`); `get_traffic_call` returns one hop. Caller uses the same `X-Devctl-Service` / loopback peer path as LLM. Recipe `expose` routes are skipped. `/reveal` cannot unmask ingest-redacted payloads. User page: [proxy.md](../proxy.md#inspect-bodies).

## Resource sampler

`ResourceSampler` periodically samples host + per-pid usage (`host-stats.ts`, Unix `vm_stat` / Windows equivalents) for the Stats screen. Independent of OpenTelemetry.

## Performance constraints

The TUI must stay usable at 50k ring events and chatty services:

- Worker ingest
- RPC event drop under queue cap
- Paged queries, not “send the whole ring”
- `logs_stats` without payloads
- Log list virtualization in `components/logs/LogList.tsx`

The web console Logs page has the same constraints on loopback HTTP (no WebSocket/SSE; `EventSource` cannot send the Bearer token):

- SPA ring cap = `logs.max_memory_events` (default 50,000); Overview “recent errors” stays a small ERROR page
- Initial page `limit=500` (daemon default); MCP `get_logs` still defaults to 200
- Follow polls only `cursor=next_cursor` (~100ms while Logs is visible, following, and not paused; backoff when idle or the tab is hidden)
- Scroll-up uses `direction=backward` + `prev_cursor`
- Facets from `GET /api/logs/stats` every 2s — not “whatever was in the last page”
- Custom list windowing in `app/web/components/log-list.tsx` (clip = fixed row height; wrap-all uses measured/estimated height)
- Export streams JSONL (`GET /api/logs/export`); do not `JSON.stringify` the ring

When adding a field to every log line, measure the worker protocol, the TUI list, and the web virtualized list, not only unit tests.
