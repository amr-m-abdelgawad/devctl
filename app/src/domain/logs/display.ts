import { anyValueSearchText, formatLogfmt, stringifyAnyValue, type AnyValue, type Attributes } from "./any-value.ts";
import { isSpanId, isTraceId, REQUEST_ID_ATTR } from "./ids.ts";
import { NANOS_PER_MS, type LogRecord } from "./types.ts";

const HEADLINE_MAX_EXTRAS = 6;
const HEADLINE_MAX_VALUE = 40;
const HEADLINE_NOISE_KEYS = new Set([
  "shape",
  "seq",
  "pid",
  "ppid",
  "tid",
  "time",
  "ts",
  "timestamp",
  "@timestamp",
  "timeUnixNano",
  "observedTimeUnixNano",
  "trace_id",
  "traceId",
  "span_id",
  "spanId",
  "traceparent",
  "ecs.version",
  "version",
  "host",
  "facility",
  "logger",
  "caller",
  "name",
  "level",
  "lvl",
  "severity",
  "severityText",
  "severityNumber",
  "severity_text",
  REQUEST_ID_ATTR,
]);

export function isoFromUnixNano(timeUnixNano: number): string {
  const ms = timeUnixNano / NANOS_PER_MS;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return new Date(0).toISOString();
  }
  return date.toISOString();
}

export function unixNanoFromIso(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return Date.now() * NANOS_PER_MS;
  }
  return ms * NANOS_PER_MS;
}

export function formatBodySummary(record: LogRecord): string {
  return formatBodyAndAttributes(record.body, record.attributes);
}

export function formatBodyAndAttributes(body: AnyValue, attributes: Attributes): string {
  const bodyPart = bodySummary(body);
  if (typeof body === "string" && body !== "") {
    const http = compactHttpLine(attributes, body);
    return http === "" ? body : `${body}  ${http}`;
  }
  if (bodyPart !== "") {
    return bodyPart;
  }
  const http = compactHttpLine(attributes, "");
  const rest = formatLogfmt(headlineFields(attributes, httpKeys()), HEADLINE_MAX_EXTRAS);
  if (http !== "" && rest !== "") {
    return `${http}  ${rest}`;
  }
  if (http !== "") {
    return http;
  }
  return rest;
}

export function logMessage(record: LogRecord): string {
  return bodySummary(record.body);
}

export function prettyPrintStructured(body: AnyValue, attributes: Attributes): string {
  const payload: Record<string, AnyValue> = {};
  if (body !== "" && body !== null) {
    payload.body = body;
  }
  if (Object.keys(attributes).length > 0) {
    payload.attributes = attributes;
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return stringifyAnyValue(body);
  }
}

export function recordSearchText(record: LogRecord): string {
  const parts = [
    formatBodySummary(record),
    anyValueSearchText(record.attributes),
    record.raw ?? "",
    record.service,
    record.traceId ?? "",
    record.spanId ?? "",
    record.identity ?? "",
    requestIdOf(record),
  ];
  return parts.join(" ");
}

export function requestIdOf(record: LogRecord): string {
  const fromAttr = record.attributes[REQUEST_ID_ATTR];
  if (typeof fromAttr === "string" && fromAttr !== "") {
    return fromAttr;
  }
  return record.traceId ?? "";
}

function bodySummary(body: AnyValue): string {
  if (typeof body === "string") {
    return body;
  }
  if (body === null) {
    return "";
  }
  if (typeof body === "number" || typeof body === "boolean") {
    return String(body);
  }
  if (Array.isArray(body)) {
    return stringifyAnyValue(body);
  }
  return formatLogfmt(headlineFields(body), HEADLINE_MAX_EXTRAS);
}

function headlineFields(attrs: Record<string, AnyValue>, extraSkip: ReadonlySet<string> = new Set()): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (isHeadlineField(key, value, extraSkip)) {
      out[key] = value;
    }
  }
  return out;
}

function isHeadlineField(key: string, value: AnyValue, extraSkip: ReadonlySet<string>): boolean {
  if (extraSkip.has(key) || HEADLINE_NOISE_KEYS.has(key)) {
    return false;
  }
  if (value === null || value === "") {
    return false;
  }
  if (typeof value === "object") {
    return false;
  }
  if (typeof value === "string" && (value.length > HEADLINE_MAX_VALUE || isTraceId(value) || isSpanId(value))) {
    return false;
  }
  return true;
}

// Single source of truth for HTTP attribute keys, shared by the TUI/CLI summary
// (compactHttpLine) and the parser's httpLine — the union of both key sets so a
// request is summarized identically no matter which code path renders it.
const HTTP_METHOD_KEYS = ["http.request.method", "http.method", "method", "request_method"];
const HTTP_ROUTE_KEYS = ["http.route", "url.path", "path", "route", "request_uri"];
const HTTP_STATUS_KEYS = ["http.status_code", "http.response.status_code", "status", "status_code"];
const HTTP_NAMESPACED_KEYS = ["http.request.method", "http.method", "http.route", "url.path", "http.status_code", "http.response.status_code"];

export function httpSummaryParts(attrs: Record<string, AnyValue>): { method?: string; route?: string; status?: string; namespaced: boolean } {
  return {
    method: firstScalar(attrs, HTTP_METHOD_KEYS),
    route: firstScalar(attrs, HTTP_ROUTE_KEYS),
    status: firstScalar(attrs, HTTP_STATUS_KEYS),
    namespaced: HTTP_NAMESPACED_KEYS.some((key) => firstScalar(attrs, [key]) !== undefined),
  };
}

function compactHttpLine(attrs: Attributes, body: string): string {
  const { method, route, status, namespaced } = httpSummaryParts(attrs);
  const parts = [method, route, status].filter((part): part is string => part !== undefined && part !== "");
  if (!namespaced && parts.length < 2) {
    return "";
  }
  const unused = parts.filter((part) => body === "" || !body.includes(part));
  return unused.join(" ");
}

function httpKeys(): Set<string> {
  return new Set([...HTTP_METHOD_KEYS, ...HTTP_ROUTE_KEYS, ...HTTP_STATUS_KEYS]);
}

function firstScalar(attrs: Attributes, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
