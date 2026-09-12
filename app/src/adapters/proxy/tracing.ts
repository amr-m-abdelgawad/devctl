import { formatTraceparent, generateSpanId, generateTraceId, isTraceId, REQUEST_ID_ATTR, startServerSpanContext, type TraceContext } from "../../domain/logs/ids.ts";
import { NANOS_PER_MS } from "../../domain/logs/types.ts";
import type { SpanIngest } from "../../domain/telemetry/types.ts";
import type { ProxyRequestRecord } from "./proxy.ts";

export const TRACEPARENT_HEADER = "traceparent";

// RequestLog.timestamp is the completion instant. Subtract duration so the
// waterfall sits on the same clock as OTLP spans from the upstream.
function proxySpanBounds(record: ProxyRequestRecord): { startUnixNano: number; endUnixNano: number } {
  const parsed = Date.parse(record.timestamp);
  const endedMs = Number.isNaN(parsed) ? Date.now() : parsed;
  const durationMs = Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0;
  return {
    startUnixNano: (endedMs - durationMs) * NANOS_PER_MS,
    endUnixNano: endedMs * NANOS_PER_MS,
  };
}

export function beginProxyTrace(headers: { traceparent?: string; requestId?: string }): TraceContext & { requestId: string } {
  return startServerSpanContext(headers);
}

export function applyTraceHeaders(headers: Record<string, string>, ctx: TraceContext & { requestId: string }, requestIdHeader: string): void {
  headers[requestIdHeader] = ctx.requestId;
  headers[TRACEPARENT_HEADER] = formatTraceparent(ctx);
}

export function proxyRecordToSpan(record: ProxyRequestRecord, ctx?: TraceContext): SpanIngest {
  const { startUnixNano, endUnixNano } = proxySpanBounds(record);
  const error = record.status >= 500 || Boolean(record.error);
  return {
    traceId: record.traceId ?? ctx?.traceId ?? (isTraceId(record.requestId) ? record.requestId.toLowerCase() : generateTraceId()),
    spanId: record.spanId ?? ctx?.spanId ?? generateSpanId(),
    parentSpanId: record.parentSpanId ?? ctx?.parentSpanId,
    name: `${record.method} ${record.route || record.path}`,
    kind: "server",
    startUnixNano,
    endUnixNano,
    status: { code: error ? "error" : "ok", message: record.error },
    attributes: {
      "http.request.method": record.method,
      "url.path": record.path,
      "http.route": record.route,
      "http.response.status_code": record.status,
      [REQUEST_ID_ATTR]: record.requestId,
      ...(record.identity ? { "enduser.id": record.identity } : {}),
    },
    events: [],
    links: [],
    resource: { "service.name": "proxy" },
  };
}
