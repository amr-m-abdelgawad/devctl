# Design: OpenTelemetry-aligned telemetry model

Status: Proposed · Owner: devctl · Scope: logs → traces, ingestion → storage → presentation

## 1. Problem

devctl invented its own flat log schema and reverse-engineers every logger's
output into it with heuristics. The visible symptom is **structured JSON lines
rendering as raw braces** in the TUI; the root cause is architectural.

Today:

- The internal model is a flat record — `LogEvent`
  (`timestamp/service/source/level/message/pid/stream?/request_id?/identity?/raw?/seq`)
  in [types.ts](../app/src/domain/logs/types.ts) and its `LogEntry` twin in
  [log-store.ts](../app/src/ports/log-store.ts).
- Normalization is key-sniffing in [parse.ts](../app/src/domain/logs/parse.ts):
  a JSON line is humanized **only** when its keys match hard-coded lists
  (`JSON_MESSAGE_KEYS = message/msg/text/log/event`, etc.). On a miss,
  `parseApplicationJsonLog` returns `message: message ?? raw`, so the whole JSON
  object is shown verbatim. Anything not a single-line `{...}` object (leading
  timestamp prefix, pretty-printed multi-line, arrays) is never parsed as JSON
  at all.
- It already recognizes OTLP-log JSON (`parseOtlpLog`) and then **downgrades
  it** — computing the attributes map and discarding it, collapsing
  `severity_number` to a string enum, and squishing `trace_id`/`span_id` into
  `request_id`. Most work, least fidelity.
- There is **no trace/span model**. `trace_id` is an alias of `request_id`.
- Persistence is lossy text: `LogManager.append` writes
  `timestamp service level raw\n` per line, and `loadSessionEvents` re-splits on
  spaces and re-parses — dropping `source`/`pid`/`request_id`/`identity` and
  unable to recover `seq` ([logs.ts](../app/src/adapters/storage/logs.ts)).

The correct fix is to make the **OpenTelemetry data model** devctl's internal
model, accept **OTLP** as a first-class lossless lane, and treat stdout/stderr
as an explicitly best-effort lane that maps *into* the model. Rendering (logfmt
summary vs. raw) then becomes a presentation decision, not a parse failure.

## 2. Goals / non-goals

**Goals**

- One internal telemetry model, OTel-shaped, for logs and (later) traces.
- No structural loss: structured payloads are preserved as `attributes`, never
  flattened to a string.
- The stdout lane never "gives up" to raw braces — an unrecognized JSON object
  becomes a structured record the renderer can summarize.
- A lossless OTLP/HTTP+JSON ingestion lane, loopback-only and opt-in.
- Correlation on real `trace_id`/`span_id`, shared with the proxy's gateway id —
  the substrate for AI-assisted debugging (`get_trace`, `trace_request`).
- Secret redaction that covers nested body/attributes, not just a message string.

**Non-goals**

- Not an APM/observability backend or a trace **viewer** — export OTLP and let
  existing viewers (otel-desktop-viewer, standalone Aspire dashboard, Tempo)
  render. The TUI gets a *navigator*, not a dashboard.
- Not requiring OTLP — a local orchestrator must ingest whatever a process
  prints. stdout/stderr stays forever as the best-effort lane.
- Not OTLP/gRPC or protobuf in phase 1 — OTLP/HTTP+JSON only.

## 3. Target domain model

Replace the flat `LogEvent` with an OTel-aligned record. Keep a few denormalized
fields (`service`, `source`, `seq`, `raw`) as devctl-local presentation/ingestion
aids.

```ts
// OTel AnyValue — body and attribute values are structured, not strings.
type AnyValue = string | number | boolean | null | AnyValue[] | { [k: string]: AnyValue };
type Attributes = Record<string, AnyValue>;

// OTel severity number 1..24 (TRACE=1..4, DEBUG=5..8, INFO=9..12, WARN=13..16,
// ERROR=17..20, FATAL=21..24). severityText is derived for display.
type SeverityNumber = number;

type Resource = { "service.name": string; [k: string]: AnyValue }; // + process.pid, etc.
type Scope = { name: string; version?: string };

type LogRecord = {
  seq: number;                    // monotonic within a daemon session (unchanged contract)
  timeUnixNano: number;           // canonical; ISO derived for display
  observedTimeUnixNano?: number;
  severityNumber: SeverityNumber;
  severityText: string;           // display, derived from severityNumber
  body: AnyValue;                 // the message: string OR structured object
  attributes: Attributes;         // structured fields preserved here
  traceId?: string;               // 32-hex
  spanId?: string;                // 16-hex
  traceFlags?: number;
  resource: Resource;             // service.name = devctl service; process.pid; etc.
  scope?: Scope;

  // devctl-local, not OTel:
  service: string;                // = resource["service.name"], denormalized for fast filter/facets
  source: string;                 // ingestion lane: stdout | stderr | otlp | devctl | history
  raw?: string;                   // original line, ONLY for the lossy stdout lane
};

type SpanKind = "server" | "client" | "internal" | "producer" | "consumer";
type Span = {
  seq: number;
  traceId: string; spanId: string; parentSpanId?: string;
  name: string; kind: SpanKind;
  startUnixNano: number; endUnixNano: number;   // duration derived
  status: { code: "unset" | "ok" | "error"; message?: string };
  attributes: Attributes;
  events: { timeUnixNano: number; name: string; attributes: Attributes }[];
  links: { traceId: string; spanId: string }[];
  resource: Resource; scope?: Scope;
};
```

`body` + `attributes` **replace** the flatten-to-`message`/dump-to-`raw`
approach. `message` and `level` become derived display concerns computed by the
presentation layer, not stored primitives.

## 4. Ingestion — two lanes into one model

### 4a. stdout/stderr (best-effort)

The parser contract changes from "extract message/level/request_id" to
"**produce a `LogRecord`**". [parse.ts](../app/src/domain/logs/parse.ts) rules:

- JSON object → `body` = recognized message key value if present, else the whole
  object; `attributes` = the remaining keys; `severityNumber` from level/
  severity keys; `traceId`/`spanId` from `trace_id`/`span_id`/`traceparent`.
  **No fall-through to raw** — an unrecognized object is a structured record.
- OTLP-log JSON → mapped 1:1 (stop discarding attributes/severity/ids). Reuse
  the existing `otlpAnyValue`/`flattenOtlpAttributes` helpers.
- Plain text → `body` = the line; `severityNumber` from the level regex;
  `attributes` empty; `raw` set.
- Out of scope (stated, not implied): multi-line pretty-printed JSON stays
  per-line best-effort in phase 1 (no cross-line buffering). A leading
  timestamp/prefix before `{` is stripped and retried.

### 4b. OTLP/HTTP+JSON receiver (lossless)

A loopback endpoint (`/v1/logs`, `/v1/traces`) accepting OTLP/HTTP+JSON, mapping
1:1 to `LogRecord`/`Span`. **No protobuf/gRPC dependency.** Services opt in via
`OTEL_EXPORTER_OTLP_ENDPOINT`, which devctl injects into managed services (the
"OTel env-wiring" from the roadmap). Bind posture in §7.

### 4c. devctl's own signals as telemetry

- **Proxy requests → Spans.** The proxy already records method/path/route/
  identity/status/duration + `X-Devctl-Request-ID`; emit each as a `server`
  span with `http.*` attributes and status. (Id-space bridging in phase 3.)
- **Process lifecycle / health transitions → LogRecords** (or span events) on a
  per-service resource, so "why did X fail" correlates crash → health → logs.

## 5. Secret redaction (phase-1, first-class)

Ground rule: tokens stay out of the TUI, logs, and MCP output. Today `append()`
redacts one string; the new model hides secrets in nested `body`/`attributes`,
and the OTLP receiver accepts structured payloads from any local process.

Requirement: redaction walks every `AnyValue` recursively (depth- and
size-bounded), over `body`, `attributes`, span attributes, and span events —
before storage and before any MCP/TUI exposure. This ships **in the same phase
as the model**, with its own tests; it must not lag behind, or there is a window
where structured secrets pass through.

## 6. Storage & persistence

- `LogStore.append` takes a `LogRecord`; the ring buffer holds records. Filters
  gain `traceId` and attribute predicates (see [log-store.ts](../app/src/ports/log-store.ts)).
- A **span index** (new `SpanStore` or an extension of `LogStore`) keyed by
  `traceId → spans`, exposing `getTrace(traceId)`. Bounded like the log ring.
- **Persistence format: JSONL of records** (one JSON object per line), replacing
  the space-delimited text. This fixes the latent `loadSessionEvents`
  space-splitting bug and makes reload lossless.

  **Compatibility rule (must be explicit):** detect format **per session
  directory**, not per line. New sessions write JSONL; a directory written by an
  older build (space-delimited `.log`) is read by the legacy reader kept for
  that purpose. Detection: presence of a `format: jsonl` marker file (or a
  `.jsonl` extension) in the session dir → new reader; else legacy. This
  directly affects [`loadSessionEvents`, `listSessions`, `pruneSessions`](../app/src/adapters/storage/logs.ts)
  and the TUI history tab — without the per-directory rule, the first user with
  old sessions gets a broken history view.
- Worker log store + IPC: the payload becomes `LogRecord`; bump
  [log-worker-protocol.ts](../app/src/adapters/storage/log-worker-protocol.ts).

## 7. Ports / adapters / config

- **New config block** for telemetry (e.g. `telemetry.otlp.enabled`,
  `telemetry.otlp.listen`). Loopback-only bind, rejecting `0.0.0.0`/`::` exactly
  like the proxy/token endpoint. **Off by default**, matching MCP's posture;
  turning it on (or injecting `OTEL_EXPORTER_OTLP_ENDPOINT`) is an explicit
  choice. This requires updates to `types/decode/merge/validate/known` and the
  JSON schema — and the repo's `schema-parity.test.ts` enforces `known.ts` ⇔
  schema, so those land together.

## 8. Presentation changes

### TUI

- **Types:** every `LogEvent` import → `LogRecord`. Components reading
  `event.message`/`event.level`/`event.raw` change.
- **LogList** ([LogList.tsx](../app/src/presentation/tui/components/logs/LogList.tsx)):
  render `body` — string as today; structured → a one-line **logfmt summary**
  (`msg key=value …`) built from `body`+`attributes`. Level color from
  `severityNumber → text`. Show a small marker when `traceId` is present.
- **helpers/logs.ts** ([logs.ts](../app/src/presentation/tui/helpers/logs.ts)):
  generalize `prettyPrintLogRaw` to pretty-print `body`+`attributes`; add
  `formatBodySummary(record)` (logfmt) for the list; `displayLogLevel` maps
  severity number→text; `filterLogs` gains attribute/trace predicates; search
  covers body + attribute values.
- **LogDetails overlay** ([LogDetails.tsx](../app/src/presentation/tui/overlays/LogDetails.tsx)):
  the payoff. Show `severityText (severityNumber)`, `body` (pretty if
  structured), a **key/value attributes table** (structured fields become
  first-class instead of a raw blob), `traceId`/`spanId` with a "view trace"
  action, resource (`service.name`, pid), scope. Replaces the single "raw json"
  section.
- **LogFilterBar** ([LogFilterBar.tsx](../app/src/presentation/tui/components/logs/LogFilterBar.tsx)):
  level facets from severity; (phase 3) a trace/errors filter.
- **Trace view (phase 3):** reachable from a log row's `traceId` and the proxy
  tab; renders the span tree. *Requirement only — the visual layout is decided
  when it's built, not here.*
- **Proxy tab:** its request rows become spans, each linking to its trace.

### CLI (`devctl logs`)

- Default output stays human (body summary). Add `--json` emitting
  **OTLP-JSON / JSONL `LogRecord`s** (pipeable to any OTel tool) in place of the
  current ad-hoc text. Add `--trace <id>` to print a trace, plus attribute/trace
  filters. `exportTo` writes JSONL/OTLP-JSON (see [cli/logs.ts](../app/src/presentation/cli/logs.ts)
  and `writeLogExport`).

### MCP (ties to the AI-debugging direction)

- `get_logs`: return records with `body`/`attributes`/`severityNumber`/
  `traceId`; add `request_id` / `trace_id` / attribute filters (today it has no
  `request_id` filter — [tools.ts](../app/src/presentation/mcp/tools.ts)).
- New `get_trace(trace_id)` / `trace_request(request_id)` → span tree +
  correlated records.
- `get_status`: surface the proxy request ring (now spans) with trace ids
  (today it exposes only `proxy: { running, address, routes }`).
- `get_requests`, `recent_errors` as previously scoped, backed by real records/
  spans.

## 9. Phasing & acceptance

**Phase 1 — Model + kill the fall-through (fixes the reported bug, correctly).**
Introduce `LogRecord` (body/attributes/severity/traceId); rewrite the stdout
parser to always produce a record with structure preserved; recursive redaction;
JSONL persistence with the per-directory compat rule; TUI renders body summary +
attributes table; CLI `--json`.

- **Acceptance = the user's actual complaint:** the JSON line that renders as
  braces today renders as a readable log, and its structured fields are a
  key/value table in LogDetails. Parser test table includes: pino/zap/logrus,
  Python structlog, ECS, GELF (`short_message`), non-standard message key,
  leading-timestamp prefix, OTLP-JSON, plain text — none renders as raw braces.
  Multi-line pretty JSON explicitly out of scope for phase 1.

**Phase 2 — OTLP/HTTP+JSON log receiver + `OTEL_EXPORTER_OTLP_ENDPOINT`
injection.** Loopback-only, off by default. Structured emitters get a lossless
lane; the heuristic lane stops being load-bearing.

**Phase 3 — Traces.** `Span` model + OTLP trace ingestion + proxy-as-spans +
`traceparent` ↔ `X-Devctl-Request-ID` shared id space (mapping mechanics decided
here — W3C ids generated at the proxy vs. mapping existing ones) + TUI trace
navigator + MCP `get_trace`/`trace_request`.

## 10. Tradeoffs & risks

- **Memory:** attributes maps and spans cost more than a flat ring. Bound
  attribute count/size (the `MAX_JSON_LOG_BYTES` cap already exists) and the span
  ring.
- **OTLP-JSON only first:** ~95% of the value, minimal dependency surface. Field
  names are camelCase with AnyValue wrapping (`stringValue`, …) — `otlpAnyValue`
  already handles this.
- **Compat:** old space-delimited sessions must keep working via the legacy
  reader (§6). New format is JSONL forward-only.
- **Scope creep:** traces are phase 3. Phase 1 must not grow a span store.

## 11. Testing

- **parse table:** the phase-1 acceptance inputs → each yields a correct record
  (body + attributes + severity + ids), none raw braces.
- **OTLP receiver:** golden OTLP-JSON payloads → records/spans.
- **persistence round-trip:** record → JSONL → reload identical (attributes,
  ids, level); legacy dir still reads via the old path.
- **redaction:** secrets nested in body/attributes/span attributes are removed
  before storage and MCP output.
- **schema-parity:** the new telemetry config block keeps `known.ts` ⇔ schema.
- **MCP:** `get_trace` returns the correlated tree for a proxy-originated request.
```
