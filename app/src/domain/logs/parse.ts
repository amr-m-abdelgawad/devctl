import { LevelDebug, LevelError, LevelFatal, LevelInfo, LevelTrace, LevelUnknown, LevelWarn, MAX_JSON_LOG_BYTES, MAX_LOG_LINE_CHARS, type LogEvent, type LogLevel, type LogParser } from "./types.ts";

export function defaultLogParser(): LogParser {
  return {
    name: "default",
    parse: (line) => {
      const structured = parseJSONLogLine(line);
      if (structured) {
        return structured;
      }
      return {
        level: parseLevel(line),
        request_id: parseRequestID(line) || undefined,
      };
    },
  };
}

// Structured loggers (pino, bunyan, zap, logrus, and similar) emit one JSON
// object per line; devctl otherwise shows that whole object as the message.
const JSON_MESSAGE_KEYS = ["message", "msg", "text", "log", "event"];
const JSON_LEVEL_KEYS = ["level", "severity", "severityText", "levelname", "loglevel", "lvl"];
const JSON_REQUEST_ID_KEYS = ["request_id", "requestId", "trace_id", "traceId", "correlation_id", "correlationId"];
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
const OTLP_SEVERITY_TRACE = 1;
const OTLP_SEVERITY_DEBUG = 5;
const OTLP_SEVERITY_INFO = 9;
const OTLP_SEVERITY_WARN = 13;
const OTLP_SEVERITY_ERROR = 17;
const OTLP_SEVERITY_FATAL = 21;

// pino's numeric level convention.
const NUMERIC_LEVELS: Record<number, LogLevel> = {
  10: LevelTrace,
  20: LevelDebug,
  30: LevelInfo,
  40: LevelWarn,
  50: LevelError,
  60: LevelFatal,
};

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function jsonLogLevel(obj: Record<string, unknown>): LogLevel | undefined {
  for (const key of JSON_LEVEL_KEYS) {
    const value = obj[key];
    if (typeof value === "number") {
      const named = NUMERIC_LEVELS[value];
      if (named) {
        return named;
      }
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return value.toUpperCase();
    }
  }
  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function firstPresent(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }
  return undefined;
}

function joinLogParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
}

function httpStatusLevel(status: number): LogLevel | undefined {
  if (status >= HTTP_SERVER_ERROR) {
    return LevelError;
  }
  if (status >= HTTP_CLIENT_ERROR) {
    return LevelWarn;
  }
  return undefined;
}

function attrMap(value: unknown): Record<string, unknown> {
  if (isJsonObject(value)) {
    return value;
  }
  return {};
}

function httpLine(attrs: Record<string, unknown>): string | undefined {
  const method = stringish(firstPresent(attrs, ["http.method", "method", "request_method"]));
  const route = stringish(firstPresent(attrs, ["http.route", "url.path", "path", "route", "request_uri"]));
  const status = stringish(firstPresent(attrs, ["http.status_code", "status", "status_code"]));
  const line = joinLogParts([method, route, status]);
  return line === "" ? undefined : line;
}

function otlpAnyValue(value: unknown): string | undefined {
  if (!isJsonObject(value)) {
    return stringish(value);
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue.trim() === "" ? undefined : value.stringValue;
  }
  return stringish(value.intValue ?? value.doubleValue ?? value.boolValue);
}

function otlpBodyMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim() !== "") {
    return body;
  }
  return otlpAnyValue(body);
}

function isOtlpAttributeList(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((item) => isJsonObject(item) && typeof item.key === "string" && item.value !== undefined);
}

function flattenOtlpAttributes(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isOtlpAttributeList(value)) {
    return out;
  }
  for (const item of value) {
    const key = item.key;
    if (typeof key === "string" && key !== "") {
      const decoded = otlpAnyValue(item.value);
      if (decoded !== undefined) {
        out[key] = decoded;
      }
    }
  }
  return out;
}

function otlpSeverity(obj: Record<string, unknown>): LogLevel | undefined {
  const text = jsonLogLevel(obj);
  if (text) {
    return text;
  }
  const n = numeric(obj.severityNumber);
  if (n === undefined) {
    return undefined;
  }
  if (n >= OTLP_SEVERITY_FATAL) {
    return LevelFatal;
  }
  if (n >= OTLP_SEVERITY_ERROR) {
    return LevelError;
  }
  if (n >= OTLP_SEVERITY_WARN) {
    return LevelWarn;
  }
  if (n >= OTLP_SEVERITY_INFO) {
    return LevelInfo;
  }
  if (n >= OTLP_SEVERITY_DEBUG) {
    return LevelDebug;
  }
  if (n >= OTLP_SEVERITY_TRACE) {
    return LevelTrace;
  }
  return undefined;
}

function isOtlpLog(obj: Record<string, unknown>): boolean {
  if (obj.timeUnixNano !== undefined || obj.observedTimeUnixNano !== undefined) {
    return true;
  }
  if (isJsonObject(obj.body) && (obj.body.stringValue !== undefined || obj.body.intValue !== undefined || obj.body.doubleValue !== undefined)) {
    return true;
  }
  return isOtlpAttributeList(obj.attributes);
}

function parseOtlpLog(obj: Record<string, unknown>, raw: string): Partial<LogEvent> | undefined {
  if (!isOtlpLog(obj)) {
    return undefined;
  }
  const attrs = flattenOtlpAttributes(obj.attributes);
  const message = otlpBodyMessage(obj.body) ?? httpLine(attrs) ?? "log";
  const requestId = firstStringField(obj, JSON_REQUEST_ID_KEYS) ?? stringish(attrs.trace_id ?? attrs.traceId);
  return { message, level: otlpSeverity(obj), request_id: requestId, raw };
}

function parseMetricLog(obj: Record<string, unknown>, raw: string): Partial<LogEvent> | undefined {
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
  const message = joinLogParts([name, metricType, amount, httpLine(attrMap(obj.attributes))]);
  return { message, raw };
}

function splitRequestLine(request: string): { method?: string; uri?: string } {
  const parts = request.trim().split(/\s+/);
  return { method: parts[0], uri: parts[1] };
}

function parseAccessLog(obj: Record<string, unknown>, raw: string): Partial<LogEvent> | undefined {
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
  return {
    message: joinLogParts([ip, method, uri, status === undefined ? undefined : String(status), size, elapsed]),
    level: status === undefined ? undefined : httpStatusLevel(status),
    request_id: firstStringField(obj, JSON_REQUEST_ID_KEYS),
    raw,
  };
}

function parseApplicationJsonLog(obj: Record<string, unknown>, raw: string): Partial<LogEvent> | undefined {
  const message = firstStringField(obj, JSON_MESSAGE_KEYS);
  const level = jsonLogLevel(obj);
  const requestId = firstStringField(obj, JSON_REQUEST_ID_KEYS);
  if (message === undefined && level === undefined && requestId === undefined) {
    return undefined;
  }
  return { message: message ?? raw, level, request_id: requestId, raw };
}

export function truncateLogLine(line: string): string {
  if (line.length <= MAX_LOG_LINE_CHARS) {
    return line;
  }
  return line.slice(0, MAX_LOG_LINE_CHARS);
}

export function parseJSONLogLine(line: string): Partial<LogEvent> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  if (trimmed.length > MAX_JSON_LOG_BYTES) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }
  return parseOtlpLog(value, trimmed) ?? parseMetricLog(value, trimmed) ?? parseAccessLog(value, trimmed) ?? parseApplicationJsonLog(value, trimmed);
}

const REQUEST_ID_RE = /(?:x-devctl-request-id|request[_-]?id)[=: ]+([A-Za-z0-9-]+)/i;
const LEVEL_PATTERNS: Array<{ re: RegExp; level: LogLevel }> = [
  { re: /\b(fatal|critical)\b/i, level: LevelFatal },
  { re: /\b(error|err)\b/i, level: LevelError },
  { re: /\b(warn|warning)\b/i, level: LevelWarn },
  { re: /\b(debug|dbg)\b/i, level: LevelDebug },
  { re: /\b(trace)\b/i, level: LevelTrace },
  { re: /\b(info|information)\b/i, level: LevelInfo },
];

export function parseLevel(line: string): LogLevel {
  const found = LEVEL_PATTERNS.find((p) => p.re.test(line));
  return found?.level ?? LevelUnknown;
}

export function parseRequestID(line: string): string {
  const match = REQUEST_ID_RE.exec(line);
  return match?.[1] ?? "";
}
