import type { AnyValue, Attributes } from "./any-value.ts";
import type { Resource, Scope } from "../telemetry/types.ts";

export type { AnyValue, Attributes } from "./any-value.ts";
export type { Resource, Scope } from "../telemetry/types.ts";

export const MAX_LOG_PAGE_SIZE = 5_000;
export const DEFAULT_LOG_PAGE_SIZE = 500;
export const MAX_LOG_LINE_CHARS = 16 * 1024;
export const MAX_JSON_LOG_BYTES = 64 * 1024;
export const NANOS_PER_MS = 1_000_000;
export const LevelTrace = "TRACE";
export const LevelDebug = "DEBUG";
export const LevelInfo = "INFO";
export const LevelWarn = "WARN";
export const LevelError = "ERROR";
export const LevelFatal = "FATAL";
export const LevelUnknown = "UNKNOWN";

export type LogLevel =
  | typeof LevelTrace
  | typeof LevelDebug
  | typeof LevelInfo
  | typeof LevelWarn
  | typeof LevelError
  | typeof LevelFatal
  | typeof LevelUnknown
  | string;

export type SeverityNumber = number;

export type LogRecord = {
  seq: number;
  timeUnixNano: number;
  observedTimeUnixNano?: number;
  severityNumber: SeverityNumber;
  severityText: string;
  body: AnyValue;
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  resource: Resource;
  scope?: Scope;
  service: string;
  source: string;
  raw?: string;
  timestamp: string;
  stream?: string;
  identity?: string;
};

export type LogIngest = {
  timestamp?: string;
  service: string;
  source: string;
  stream?: string;
  pid: number;
  identity?: string;
  message?: string;
  level?: string;
  request_id?: string;
  body?: AnyValue;
  attributes?: Attributes;
  severityNumber?: number;
  severityText?: string;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  resource?: Resource;
  scope?: Scope;
  raw?: string;
  timeUnixNano?: number;
  observedTimeUnixNano?: number;
};

export type ParsedLog = {
  body?: AnyValue;
  attributes?: Attributes;
  severityNumber?: number;
  severityText?: string;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  timeUnixNano?: number;
  observedTimeUnixNano?: number;
  scope?: Scope;
  resource?: Resource;
  raw?: string;
  message?: string;
  level?: string;
  request_id?: string;
};

export type LogParser = {
  name: string;
  parse: (line: string) => ParsedLog | undefined;
};

export type LogFilter = {
  services?: string[];
  level?: string;
  source?: string;
  search?: string;
  regex?: boolean;
  since?: string;
  until?: string;
  traceId?: string;
  requestId?: string;
  attribute?: { key: string; value: string };
};

export type LogPageDirection = "forward" | "backward";

export type LogPageRequest = {
  cursor?: string;
  direction?: LogPageDirection;
  limit?: number;
};

export type LogPage = {
  events: LogRecord[];
  nextCursor: string;
  prevCursor: string;
  hasNext: boolean;
  hasPrev: boolean;
  sessionChanged: boolean;
};

export type LogFacets = {
  total: number;
  byService: Record<string, number>;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
};

export type LogEvent = LogRecord;
