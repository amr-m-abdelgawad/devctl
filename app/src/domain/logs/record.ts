import { coerceAnyValue, coerceAttributes, type AnyValue, type Attributes } from "./any-value.ts";
import { isoFromUnixNano, unixNanoFromIso } from "./display.ts";
import { REQUEST_ID_ATTR, isSpanId, isTraceId } from "./ids.ts";
import { SeverityUnspecified, severityNumberFromText, severityTextFromNumber } from "./severity.ts";
import { LevelUnknown, type LogIngest, type LogRecord, type ParsedLog } from "./types.ts";
import type { Resource } from "../telemetry/types.ts";

export type LogRecordDraft = {
  timestamp?: string;
  service?: string;
  source?: string;
  stream?: string;
  level?: string;
  message?: string;
  pid?: number;
  seq?: number;
  raw?: string;
  request_id?: string;
  identity?: string;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  body?: AnyValue;
  attributes?: Attributes;
  resource?: Resource;
  scope?: LogRecord["scope"];
  severityNumber?: number;
  severityText?: string;
  timeUnixNano?: number;
  observedTimeUnixNano?: number;
};

export function logRecord(draft: LogRecordDraft): LogRecord {
  const service = draft.service ?? "svc";
  const timestamp = draft.timestamp ?? isoFromUnixNano(draft.timeUnixNano ?? Date.now() * 1_000_000);
  const timeUnixNano = draft.timeUnixNano ?? unixNanoFromIso(timestamp);
  const severityNumber = draft.severityNumber ?? severityNumberFromText(draft.level ?? LevelUnknown);
  const severityText = draft.severityText ?? (severityNumber === SeverityUnspecified ? LevelUnknown : severityTextFromNumber(severityNumber));
  const attributes = { ...(draft.attributes ?? {}) };
  if (draft.request_id && attributes[REQUEST_ID_ATTR] === undefined) {
    attributes[REQUEST_ID_ATTR] = draft.request_id;
  }
  const pid = draft.pid ?? 0;
  const resource: Resource = draft.resource ?? {
    "service.name": service,
    ...(pid > 0 ? { "process.pid": pid } : {}),
  };
  const body = draft.body !== undefined ? draft.body : (draft.message ?? "");
  const traceId = draft.traceId ?? (draft.request_id && isTraceId(draft.request_id) ? draft.request_id.toLowerCase() : undefined);
  const spanId = draft.spanId && isSpanId(draft.spanId) ? draft.spanId.toLowerCase() : draft.spanId;
  return {
    seq: draft.seq ?? 0,
    timeUnixNano,
    observedTimeUnixNano: draft.observedTimeUnixNano,
    severityNumber,
    severityText,
    body,
    attributes,
    traceId,
    spanId,
    traceFlags: draft.traceFlags,
    resource,
    scope: draft.scope,
    service,
    source: draft.source ?? "stdout",
    raw: draft.raw,
    timestamp,
    stream: draft.stream,
    identity: draft.identity,
  };
}

export function buildLogRecord(ingest: LogIngest, parsed: ParsedLog, seq: number): LogRecord {
  const timestamp = ingest.timestamp && ingest.timestamp !== "" ? ingest.timestamp : isoFromUnixNano(parsed.timeUnixNano ?? ingest.timeUnixNano ?? Date.now() * 1_000_000);
  const timeUnixNano = parsed.timeUnixNano ?? ingest.timeUnixNano ?? unixNanoFromIso(timestamp);
  const body = firstBody(ingest, parsed);
  const attributes = {
    ...coerceAttributes(parsed.attributes ?? {}),
    ...coerceAttributes(ingest.attributes ?? {}),
  };
  const requestId = ingest.request_id || parsed.request_id;
  if (requestId && attributes[REQUEST_ID_ATTR] === undefined) {
    attributes[REQUEST_ID_ATTR] = requestId;
  }
  const severityNumber = resolveSeverity(ingest, parsed);
  const severityText = (
    ingest.severityText ||
    ingest.level ||
    parsed.severityText ||
    parsed.level ||
    (severityNumber === SeverityUnspecified ? LevelUnknown : severityTextFromNumber(severityNumber))
  ).toUpperCase();
  const traceId = normalizeTraceId(ingest.traceId || parsed.traceId || (requestId && isTraceId(requestId) ? requestId : undefined));
  const spanId = normalizeSpanId(ingest.spanId || parsed.spanId);
  const service = ingest.service;
  const pid = ingest.pid;
  const resource: Resource = ingest.resource ?? parsed.resource ?? {
    "service.name": service,
    ...(pid > 0 ? { "process.pid": pid } : {}),
  };
  if (resource["service.name"] === undefined) {
    resource["service.name"] = service;
  }
  return {
    seq,
    timeUnixNano,
    observedTimeUnixNano: parsed.observedTimeUnixNano ?? ingest.observedTimeUnixNano,
    severityNumber,
    severityText,
    body: coerceAnyValue(body),
    attributes,
    traceId,
    spanId,
    traceFlags: ingest.traceFlags ?? parsed.traceFlags,
    resource,
    scope: ingest.scope ?? parsed.scope,
    service,
    source: ingest.source,
    raw: parsed.raw ?? ingest.raw,
    timestamp,
    stream: ingest.stream,
    identity: ingest.identity,
  };
}

function firstBody(ingest: LogIngest, parsed: ParsedLog): AnyValue {
  if (ingest.body !== undefined) {
    return ingest.body;
  }
  if (parsed.body !== undefined) {
    return parsed.body;
  }
  if (parsed.message !== undefined) {
    return parsed.message;
  }
  return ingest.message ?? "";
}

function resolveSeverity(ingest: LogIngest, parsed: ParsedLog): number {
  if (ingest.severityNumber !== undefined && ingest.severityNumber !== SeverityUnspecified) {
    return ingest.severityNumber;
  }
  const ingestText = ingest.severityText || ingest.level;
  if (ingestText) {
    const named = severityNumberFromText(ingestText);
    if (named !== SeverityUnspecified) {
      return named;
    }
  }
  if (parsed.severityNumber !== undefined && parsed.severityNumber !== SeverityUnspecified) {
    return parsed.severityNumber;
  }
  const parsedText = parsed.severityText || parsed.level;
  if (parsedText) {
    return severityNumberFromText(parsedText);
  }
  return SeverityUnspecified;
}

function normalizeTraceId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return isTraceId(value) ? value.toLowerCase() : value;
}

function normalizeSpanId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return isSpanId(value) ? value.toLowerCase() : value;
}
