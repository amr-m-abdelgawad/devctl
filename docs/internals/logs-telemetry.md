# Logs, telemetry, LLM inspector

Three related stores, one redaction story. User pages: [logs.md](../logs.md), [telemetry.md](../telemetry.md), [llm.md](../llm.md).

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

Filters: service, level, search/regex, source, since/until, request_id, trace_id, attribute key/value. Facets (`logs_stats`) are the cheap poll.

Parsers: built-in line parser + plugin `LogParser`. Python-literal and OTLP AnyValue decoders live in domain so MCP/TUI share them.

Export: `logs` RPC with `export` path, or client-side `writeLogExport`.

## Redaction

`adapters/secrets/detector.ts` + `domain/logs/redact.ts` + `shared/redaction.ts`. Markers include PASSWORD, TOKEN, SECRET, … plus `secrets.extra_markers` / `extra_patterns`. MCP and web always redact. TUI redacts unless `/reveal`.

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
- **push** (`proxy`, `adapters/llm/proxy-driver.ts`): the coordinator registers **no** timer and never resolves a management hop. Instead `ProxyCaptureSink` (`adapters/llm/proxy-capture.ts`) tees OpenAI-compatible completion bodies off a tagged proxy route (`via.route`), reassembles SSE, maps them (`proxy-capture-map.ts`), and upserts straight into the store. The HTTP proxy depends only on the `LlmCaptureSink` port, so the proxy adapter never imports the llm package.

Plugins may register other `LlmSourceDriver`s (pull by default).

Store: `LlmCallManager` (ring + redact). List endpoints strip bodies (`stripLlmBodies`); `get_llm_call` returns one call for detail overlays.

`capture.prompts` gates prompt/response retention (the push path applies `stripLlmBodies` itself, since it bypasses the coordinator); `capture.max_bytes` bounds a captured body. Poll interval: `poll_seconds` (default 5, pull only).

## Resource sampler

`ResourceSampler` periodically samples host + per-pid usage (`host-stats.ts`, Unix `vm_stat` / Windows equivalents) for the Stats screen. Independent of OpenTelemetry.

## Performance constraints

The TUI must stay usable at 50k ring events and chatty services:

- Worker ingest
- RPC event drop under queue cap
- Paged queries, not “send the whole ring”
- `logs_stats` without payloads
- Log list virtualization in `components/logs/LogList.tsx`

When adding a field to every log line, measure the worker protocol and the TUI list, not only unit tests.
