import { coerceAnyValue, coerceAttributes, isPlainObject, type AnyValue, type Attributes } from "./any-value.ts";
import { REQUEST_ID_ATTR, SPAN_ID_HEX_LENGTH, TRACE_ID_HEX_LENGTH, isSpanId, isTraceId, parseTraceparent } from "./ids.ts";
import { decodeOtlpAnyValue, flattenOtlpAttributes, isOtlpAttributeList, unixNanoFromUnknown } from "./otlp-value.ts";
import { httpSummaryParts } from "./display.ts";
import { SeverityError, SeverityUnspecified, SeverityWarn, severityNumberFromUnknown, severityTextFromNumber, syslogSeverity } from "./severity.ts";
import { MAX_JSON_LOG_BYTES, MAX_LOG_LINE_CHARS, NANOS_PER_MS, type LogParser, type ParsedLog } from "./types.ts";

export function defaultLogParser(): LogParser {
  return {
    name: "default",
    parse: (line) => parseLogLine(line),
  };
}

const JSON_MESSAGE_KEYS = ["message", "msg", "text", "log", "event", "short_message", "shortMessage"];
const JSON_LEVEL_KEYS = ["level", "severity", "severityText", "severity_text", "levelname", "loglevel", "lvl"];
const JSON_TRACE_KEYS = ["trace_id", "traceId", "traceid"];
const JSON_SPAN_KEYS = ["span_id", "spanId", "spanid"];
const JSON_REQUEST_ID_KEYS = ["request_id", "requestId", "correlation_id", "correlationId", REQUEST_ID_ATTR];
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;

export function truncateLogLine(line: string): string {
  if (line.length <= MAX_LOG_LINE_CHARS) {
    return line;
  }
  return line.slice(0, MAX_LOG_LINE_CHARS);
}

export function parseLogLine(line: string): ParsedLog {
  const structured = parseJSONLogLine(line);
  if (structured) {
    return structured;
  }
  return {
    body: line,
    attributes: {},
    severityNumber: severityFromPlainText(line),
    severityText: severityTextFromNumber(severityFromPlainText(line)),
    request_id: parseRequestID(line) || undefined,
    raw: line,
  };
}

export function parseJSONLogLine(line: string): ParsedLog | undefined {
  const extracted = extractJsonObject(line);
  if (!extracted) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(extracted.json);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  return parseOtlpLog(value, extracted.raw) ?? parseMetricLog(value, extracted.raw) ?? parseAccessLog(value, extracted.raw) ?? parseApplicationJsonLog(value, extracted.raw);
}

function extractJsonObject(line: string): { json: string; raw: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length > MAX_JSON_LOG_BYTES) {
    return undefined;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return { json: trimmed, raw: trimmed };
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start <= 0 || end <= start) {
    return undefined;
  }
  const candidate = trimmed.slice(start, end + 1);
  if (candidate.length > MAX_JSON_LOG_BYTES) {
    return undefined;
  }
  try {
    const value = JSON.parse(candidate);
    if (!isPlainObject(value)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { json: candidate, raw: trimmed };
}

function parseOtlpLog(obj: Record<string, unknown>, raw: string): ParsedLog | undefined {
  if (!isOtlpLog(obj)) {
    return undefined;
  }
  const attributes = flattenOtlpAttributes(obj.attributes);
  const body = obj.body === undefined ? otlpFallbackBody(attributes) : decodeOtlpAnyValue(obj.body);
  const severityNumber = severityNumberFromUnknown(obj.severityNumber) ?? severityNumberFromUnknown(obj.severityText) ?? severityNumberFromUnknown(obj.severity_text);
  const traceId = firstHex(obj, JSON_TRACE_KEYS, TRACE_ID_HEX_LENGTH) ?? stringAttr(attributes, JSON_TRACE_KEYS);
  const spanId = firstHex(obj, JSON_SPAN_KEYS, SPAN_ID_HEX_LENGTH) ?? stringAttr(attributes, JSON_SPAN_KEYS);
  return {
    body,
    attributes,
    severityNumber,
    severityText: typeof obj.severityText === "string" ? obj.severityText : undefined,
    traceId,
    spanId,
    timeUnixNano: unixNanoFromUnknown(obj.timeUnixNano),
    observedTimeUnixNano: unixNanoFromUnknown(obj.observedTimeUnixNano),
    raw,
  };
}

function isOtlpLog(obj: Record<string, unknown>): boolean {
  if (obj.timeUnixNano !== undefined || obj.observedTimeUnixNano !== undefined) {
    return true;
  }
  if (isPlainObject(obj.body) && (obj.body.stringValue !== undefined || obj.body.intValue !== undefined || obj.body.doubleValue !== undefined || obj.body.boolValue !== undefined)) {
    return true;
  }
  return isOtlpAttributeList(obj.attributes);
}

function otlpFallbackBody(attrs: Attributes): AnyValue {
  const line = httpLine(attrs);
  return line ?? "";
}

function parseMetricLog(obj: Record<string, unknown>, raw: string): ParsedLog | undefined {
  const name = stringish(obj.metric_name);
  if (name === undefined) {
    return undefined;
  }
  const metricType = stringish(obj.metric_type);
  const value = numeric(obj.value);
  if (metricType === undefined && value === undefined) {
    return undefined;
  }
  const unit = stringish(obj.unit);
  const amount = value === undefined ? undefined : unit === undefined ? String(value) : `${value} ${unit}`;
  const nested = isPlainObject(obj.attributes) ? coerceAttributes(obj.attributes) : {};
  const summary = joinLogParts([name, metricType, amount, httpLine(nested)]);
  const { attributes } = splitFields(obj, ["metric_name", "metric_type", "value", "unit", "attributes"]);
  return {
    body: summary,
    attributes: { ...attributes, ...nested },
    raw,
  };
}

function parseAccessLog(obj: Record<string, unknown>, raw: string): ParsedLog | undefined {
  if (firstStringField(obj, JSON_MESSAGE_KEYS) !== undefined) {
    return undefined;
  }
  const requestLine = stringish(obj.request);
  const fromRequest = requestLine === undefined ? {} : splitRequestLine(requestLine);
  const method = stringish(firstPresent(obj, ["request_method", "method", "http_method", "verb"])) ?? fromRequest.method;
  const uri = stringish(firstPresent(obj, ["request_uri", "uri", "url", "path", "request_path"])) ?? fromRequest.uri;
  const status = numeric(firstPresent(obj, ["status", "status_code", "statusCode", "http_status"]));
  const ip = stringish(firstPresent(obj, ["remote_ip", "remote_addr", "client_ip"]));
  if (method === undefined || uri === undefined) {
    return undefined;
  }
  if (status === undefined && ip === undefined && requestLine === undefined) {
    return undefined;
  }
  const bytes = numeric(firstPresent(obj, ["body_bytes_sent", "bytes_sent", "bytes"]));
  const seconds = numeric(firstPresent(obj, ["request_time", "duration"]));
  const millis = numeric(firstPresent(obj, ["request_time_ms", "latency_ms", "duration_ms"]));
  const size = bytes === undefined ? undefined : `${bytes}B`;
  const elapsed = millis !== undefined ? `${millis}ms` : seconds === undefined ? undefined : `${seconds}s`;
  const { attributes, traceId, spanId, requestId, severityNumber } = splitFields(obj, []);
  return {
    body: joinLogParts([ip, method, uri, status === undefined ? undefined : String(status), size, elapsed]),
    attributes,
    severityNumber: severityNumber ?? (status === undefined ? undefined : httpStatusSeverity(status)),
    traceId,
    spanId,
    request_id: requestId,
    raw,
  };
}

function parseApplicationJsonLog(obj: Record<string, unknown>, raw: string): ParsedLog {
  const split = splitFields(obj, []);
  const message = firstPresentValue(obj, JSON_MESSAGE_KEYS);
  // A top-level `body` field (OTLP-flavoured flat JSON that did not trip
  // isOtlpLog) is lifted out of `remainder`, so fall back to it before dumping
  // the remaining fields — otherwise its value is silently dropped.
  const body =
    message !== undefined
      ? coerceAnyValue(message)
      : obj.body !== undefined && obj.body !== null
        ? coerceAnyValue(obj.body)
        : coerceAnyValue(split.remainder);
  return {
    body,
    attributes: split.attributes,
    severityNumber: split.severityNumber,
    severityText: split.severityText,
    traceId: split.traceId,
    spanId: split.spanId,
    request_id: split.requestId,
    timeUnixNano: split.timeUnixNano,
    raw,
  };
}

function splitFields(obj: Record<string, unknown>, extraLifted: string[]): {
  attributes: Attributes;
  remainder: Record<string, AnyValue>;
  severityNumber?: number;
  severityText?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  timeUnixNano?: number;
} {
  const lifted = new Set([...JSON_MESSAGE_KEYS, ...JSON_LEVEL_KEYS, ...JSON_TRACE_KEYS, ...JSON_SPAN_KEYS, ...JSON_REQUEST_ID_KEYS, "traceparent", "trace_flags", "traceFlags", "timeUnixNano", "observedTimeUnixNano", "timestamp", "time", "@timestamp", "ts", "body", ...extraLifted]);
  const gelf = typeof obj.short_message === "string";
  const severityNumber = readSeverity(obj, gelf);
  const severityText = firstStringField(obj, JSON_LEVEL_KEYS);
  const traceparent = typeof obj.traceparent === "string" ? parseTraceparent(obj.traceparent) : undefined;
  const traceId = firstHex(obj, JSON_TRACE_KEYS, TRACE_ID_HEX_LENGTH) ?? traceparent?.traceId;
  const spanId = firstHex(obj, JSON_SPAN_KEYS, SPAN_ID_HEX_LENGTH) ?? traceparent?.parentSpanId;
  const requestId = firstStringField(obj, JSON_REQUEST_ID_KEYS);
  const timeUnixNano = unixNanoFromUnknown(obj.timeUnixNano) ?? isoLikeToNano(obj);
  const remainder: Record<string, AnyValue> = {};
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!lifted.has(key)) {
      const coerced = coerceAnyValue(value);
      remainder[key] = coerced;
      attributes[key] = coerced;
    }
  }
  if (requestId && attributes[REQUEST_ID_ATTR] === undefined) {
    attributes[REQUEST_ID_ATTR] = requestId;
  }
  return { attributes, remainder, severityNumber, severityText, traceId, spanId, requestId, timeUnixNano };
}

function readSeverity(obj: Record<string, unknown>, gelf: boolean): number | undefined {
  for (const key of JSON_LEVEL_KEYS) {
    const value = obj[key];
    if (value !== undefined && value !== null) {
      if (gelf && typeof value === "number") {
        const syslog = syslogSeverity(value);
        if (syslog !== undefined) {
          return syslog;
        }
      }
      const mapped = severityNumberFromUnknown(value);
      if (mapped !== undefined) {
        return mapped;
      }
    }
  }
  return undefined;
}

function isoLikeToNano(obj: Record<string, unknown>): number | undefined {
  for (const key of ["timestamp", "time", "@timestamp", "ts"]) {
    const value = obj[key];
    if (typeof value === "string" && value !== "") {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) {
        return ms * 1_000_000;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e15 ? value : value * NANOS_PER_MS;
    }
  }
  return undefined;
}

function httpLine(attrs: Record<string, AnyValue>): string | undefined {
  const { method, route, status } = httpSummaryParts(attrs);
  const line = joinLogParts([method, route, status]);
  return line === "" ? undefined : line;
}

function httpStatusSeverity(status: number): number | undefined {
  if (status >= HTTP_SERVER_ERROR) {
    return SeverityError;
  }
  if (status >= HTTP_CLIENT_ERROR) {
    return SeverityWarn;
  }
  return undefined;
}

function splitRequestLine(request: string): { method?: string; uri?: string } {
  const parts = request.trim().split(/\s+/);
  return { method: parts[0], uri: parts[1] };
}

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function firstPresentValue(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }
  return undefined;
}

function firstPresent(obj: Record<string, unknown>, keys: string[]): unknown {
  return firstPresentValue(obj, keys);
}

function firstHex(obj: Record<string, unknown>, keys: string[], length: number): string | undefined {
  const value = firstStringField(obj, keys);
  if (!value) {
    return undefined;
  }
  if (length === TRACE_ID_HEX_LENGTH && isTraceId(value)) {
    return value.toLowerCase();
  }
  if (length === SPAN_ID_HEX_LENGTH && isSpanId(value)) {
    return value.toLowerCase();
  }
  return value;
}

function stringAttr(attrs: Attributes, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

function stringish(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function joinLogParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
}

const REQUEST_ID_RE = /(?:x-devctl-request-id|request[_-]?id)[=: ]+([A-Za-z0-9-]+)/i;
const LEVEL_PATTERNS: Array<{ re: RegExp; level: number }> = [
  { re: /\b(fatal|critical)\b/i, level: severityNumberFromUnknown("FATAL") ?? SeverityUnspecified },
  { re: /\b(error|err)\b/i, level: severityNumberFromUnknown("ERROR") ?? SeverityUnspecified },
  { re: /\b(warn|warning)\b/i, level: severityNumberFromUnknown("WARN") ?? SeverityUnspecified },
  { re: /\b(debug|dbg)\b/i, level: severityNumberFromUnknown("DEBUG") ?? SeverityUnspecified },
  { re: /\b(trace)\b/i, level: severityNumberFromUnknown("TRACE") ?? SeverityUnspecified },
  { re: /\b(info|information)\b/i, level: severityNumberFromUnknown("INFO") ?? SeverityUnspecified },
];

export function parseRequestID(line: string): string {
  const match = REQUEST_ID_RE.exec(line);
  return match?.[1] ?? "";
}

function severityFromPlainText(line: string): number {
  const found = LEVEL_PATTERNS.find((p) => p.re.test(line));
  return found?.level ?? SeverityUnspecified;
}

export function structuredBodyLooksLikeBraces(body: AnyValue): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const trimmed = body.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}
