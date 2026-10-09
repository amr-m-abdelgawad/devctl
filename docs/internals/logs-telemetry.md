# Logs, telemetry, LLM inspector

Three related stores, one redaction story. User pages: [logs.md](../logs.md), [telemetry.md](../telemetry.md), [llm.md](../llm.md), [proxy.md](../proxy.md#inspect-bodies).

## Log store

Production daemon: `createDaemonLogStore` (`adapters/storage/worker-log-store.ts`).

- Prefers a **worker thread** (`log-worker.ts`, protocol in `log-worker-protocol.ts`) so high-volume stdout does not block RPC.
- Traffic is batched both ways. Raw chunks go within a per-stream and total credit window. Structured appends (hooks, tasks, exec, proxy, OTLP) go through `AppendLane`, at most one batch per 5 ms tick, within 4 MiB of unacked bytes; past 16 MiB held, `ingestPaused()` is true. The worker sends committed records back at most 20 times a second, and acks appends by id with them.
- A worker lost after it was ready is restarted once with the session's settings and every unacked chunk and append; a second loss hands the same to the in-process store. Either continues the session's seqs and spool.
- Every line carries the time it was read (`readAtMs`). Folding, proxy-hop pairing, and access-line dedupe go by it, so spooled or late output comes out as it would have live.
- Spool segments are written and read without blocking the thread, one write and one read in flight per stream.
- Falls back in-process (`LogManager`) if the worker fails; logs a WARN. Compiled standalone binaries run the worker too: `compile-binaries.sh` embeds it beside the entrypoint, where `resolveWorkerUrl` finds it (the npm bundle ships it at the same place in `dist/`).
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

Filters: service, level, search/regex, source, since/until, request_id, trace_id, attribute key/value. Ingest copies `devctl.request_id` from a proxy hop onto a nearby service line that names the same method (50ms timestamp match and 50ms read-time match, by `ProxyHopWindow`; candidates stay until the low watermark, the oldest read time still to commit, has passed them by 50ms; HTTP hops require a request-target). If the service line arrived first, the tagged record is re-emitted and persisted. Optional query-time `dedupeRequestId` then collapses those pairs after the page is fetched. Facets (`logs_stats`) are the cheap poll: for a filter on service, level and source alone they come from `FacetWindow`, a per-seq table of those three fields kept at commit, and are exact over the logical window; any other filter is counted over the ring.

Session files (`SessionLogWriter`, `SessionReader`): each service's records go to `<service>.jsonl`, then `<service>~N.jsonl`, one whole record a line, seqs rising. Beside a part, `<part>.idx` holds `offset bound` lines (every seq written before `offset` is at most `bound`): offset 0 with the first seq less one, a checkpoint each 64 KiB, and, once the part is sealed, its size and last seq. A re-emitted record is swapped in the writer's batch if its original is still there; otherwise the new copy is appended to `<part>.patch` beside the part that holds the original, never to the part. Readers lay patches over a part by seq (`SessionReader`, `loadJsonlSession`, `loadSessionTail`) and seek with the index. `SessionReader` does not hold patch text: the first time it reads a part it notes which stretch of the patch file (about 64 KiB) holds which seqs, reads a stretch when a range needs it, and points a cached match of a patched record at its line in the patch file. A part with no index (an older devctl wrote it) or the lines a crash replay appended past one are probed lazily and read with look-ahead for a late copy. Index and patch bytes count toward the session cap and are deleted with their part.

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

The store is capped at 10,000 spans and at a byte budget (`telemetry.store_max_bytes`, 64 MiB by default). Each span is sized once, as stored after redaction, by `approxSpanBytes` (`domain/logs/size.ts`): every string in its attributes, events and resource, with no walk limit, plus a fixed overhead. Over either cap the oldest spans are evicted with their trace and request-id index entries. The memory guard scales the budget with the log ring's (half at 75% of the limit, a quarter at 90%).

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
