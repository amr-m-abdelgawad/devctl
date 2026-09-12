import { isPlainObject } from "../logs/any-value.ts";
import { decodeOtlpAnyValue, flattenOtlpAttributes, resourceFromOtlp, scopeFromOtlp, unixNanoFromUnknown } from "../logs/otlp-value.ts";
import { otlpSeverityNumber, severityTextFromNumber } from "../logs/severity.ts";
import { isSpanId, isTraceId } from "../logs/ids.ts";
import type { LogIngest } from "../logs/types.ts";
import { spanKindFromOtlp, spanStatusFromOtlp } from "./span-kind.ts";
import type { SpanEvent, SpanIngest, SpanLink } from "./types.ts";

export function mapOtlpLogs(payload: unknown, fallbackService: string): LogIngest[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.resourceLogs)) {
    return [];
  }
  return payload.resourceLogs.flatMap((resourceLog) => mapResourceLogs(resourceLog, fallbackService));
}

export function mapOtlpTraces(payload: unknown, fallbackService: string): SpanIngest[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.resourceSpans)) {
    return [];
  }
  return payload.resourceSpans.flatMap((resourceSpan) => mapResourceSpans(resourceSpan, fallbackService));
}

function mapResourceLogs(resourceLog: unknown, fallbackService: string): LogIngest[] {
  if (!isPlainObject(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
    return [];
  }
  const resource = resourceFromOtlp(resourceLog.resource, fallbackService);
  const service = resource["service.name"];
  return resourceLog.scopeLogs.flatMap((scopeLog) => mapScopeLogs(scopeLog, resource, service));
}

function mapScopeLogs(scopeLog: unknown, resource: LogIngest["resource"], service: string): LogIngest[] {
  if (!isPlainObject(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
    return [];
  }
  const scope = scopeFromOtlp(scopeLog.scope);
  const pid = typeof resource?.["process.pid"] === "number" ? resource["process.pid"] : 0;
  return scopeLog.logRecords.flatMap((rec) => {
    if (!isPlainObject(rec) || resource === undefined) {
      return [];
    }
    const severityNumber = otlpSeverityNumber(rec.severityNumber);
    return [{
      service,
      source: "otlp",
      pid,
      body: rec.body === undefined ? "" : decodeOtlpAnyValue(rec.body),
      attributes: flattenOtlpAttributes(rec.attributes),
      severityNumber,
      severityText: typeof rec.severityText === "string" && rec.severityText !== "" ? rec.severityText : severityTextFromNumber(severityNumber),
      traceId: hex32(rec.traceId),
      spanId: hex16(rec.spanId),
      traceFlags: typeof rec.flags === "number" ? rec.flags : undefined,
      timeUnixNano: unixNanoFromUnknown(rec.timeUnixNano),
      observedTimeUnixNano: unixNanoFromUnknown(rec.observedTimeUnixNano),
      resource,
      scope,
    }];
  });
}

function mapResourceSpans(resourceSpan: unknown, fallbackService: string): SpanIngest[] {
  if (!isPlainObject(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans)) {
    return [];
  }
  const resource = resourceFromOtlp(resourceSpan.resource, fallbackService);
  return resourceSpan.scopeSpans.flatMap((scopeSpan) => mapScopeSpans(scopeSpan, resource));
}

function mapScopeSpans(scopeSpan: unknown, resource: SpanIngest["resource"]): SpanIngest[] {
  if (!isPlainObject(scopeSpan) || !Array.isArray(scopeSpan.spans)) {
    return [];
  }
  const scope = scopeFromOtlp(scopeSpan.scope);
  return scopeSpan.spans.flatMap((rec) => {
    if (!isPlainObject(rec)) {
      return [];
    }
    const traceId = hex32(rec.traceId);
    const spanId = hex16(rec.spanId);
    if (!traceId || !spanId) {
      return [];
    }
    return [{
      traceId,
      spanId,
      parentSpanId: hex16(rec.parentSpanId),
      name: typeof rec.name === "string" && rec.name !== "" ? rec.name : "span",
      kind: spanKindFromOtlp(rec.kind),
      startUnixNano: unixNanoFromUnknown(rec.startTimeUnixNano) ?? 0,
      endUnixNano: unixNanoFromUnknown(rec.endTimeUnixNano) ?? 0,
      status: spanStatusFromOtlp(rec.status),
      attributes: flattenOtlpAttributes(rec.attributes),
      events: mapSpanEvents(rec.events),
      links: mapSpanLinks(rec.links),
      resource,
      scope,
    }];
  });
}

function mapSpanEvents(value: unknown): SpanEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isPlainObject(item) || typeof item.name !== "string") {
      return [];
    }
    return [{
      timeUnixNano: unixNanoFromUnknown(item.timeUnixNano) ?? 0,
      name: item.name,
      attributes: flattenOtlpAttributes(item.attributes),
    }];
  });
}

function mapSpanLinks(value: unknown): SpanLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isPlainObject(item)) {
      return [];
    }
    const traceId = hex32(item.traceId);
    const spanId = hex16(item.spanId);
    if (!traceId || !spanId) {
      return [];
    }
    return [{ traceId, spanId }];
  });
}

function hex32(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return isTraceId(value) ? value.toLowerCase() : undefined;
}

function hex16(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return isSpanId(value) ? value.toLowerCase() : undefined;
}
