import { parseJSONLogLine } from "./parse.ts";
import { NANOS_PER_MS, type LogRecord } from "./types.ts";
import type { AnyValue, Attributes } from "./any-value.ts";

export const DEFAULT_ACCESS_LINE_DEDUPE_WINDOW_MS = 1;

const ACCESS_LINE_RE = /"([A-Z]+)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})\b/;

const METHOD_KEYS = ["http.request.method", "http.method", "method"];
const PATH_KEYS = ["http.target", "url.path", "http.route", "path"];
const STATUS_KEYS = ["http.status_code", "http.response.status_code", "status"];

export function shouldDropAccessLine(prev: LogRecord, next: LogRecord, windowMs = DEFAULT_ACCESS_LINE_DEDUPE_WINDOW_MS): boolean {
  if (prev.service !== next.service || !samePid(prev, next)) {
    return false;
  }
  if (Math.abs(next.timeUnixNano - prev.timeUnixNano) > windowMs * NANOS_PER_MS) {
    return false;
  }
  const nextLine = parsePlainAccessLine(next);
  if (!nextLine) {
    return false;
  }
  const prevParts = httpAccessParts(prev.attributes);
  if (!prevParts) {
    return false;
  }
  return prevParts.method === nextLine.method && prevParts.path === nextLine.path && prevParts.status === nextLine.status;
}

export function parsePlainAccessLine(record: LogRecord): { method: string; path: string; status: string } | undefined {
  const text = accessLineText(record);
  if (text === "") {
    return undefined;
  }
  if (parseJSONLogLine(text) || (record.raw !== undefined && record.raw !== text && parseJSONLogLine(record.raw))) {
    return undefined;
  }
  if (httpAccessParts(record.attributes)) {
    return undefined;
  }
  const match = ACCESS_LINE_RE.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return { method: match[1], path: match[2], status: match[3] };
}

export function httpAccessParts(attrs: Attributes): { method: string; path: string; status: string } | undefined {
  const method = firstScalar(attrs, METHOD_KEYS);
  const path = firstScalar(attrs, PATH_KEYS);
  const status = firstScalar(attrs, STATUS_KEYS);
  if (!method || !path || !status) {
    return undefined;
  }
  return { method, path, status };
}

function samePid(left: LogRecord, right: LogRecord): boolean {
  const leftPid = pidOf(left);
  const rightPid = pidOf(right);
  return leftPid !== undefined && leftPid === rightPid;
}

function pidOf(record: LogRecord): number | undefined {
  const value = record.resource["process.pid"];
  return typeof value === "number" && value > 0 ? value : undefined;
}

function accessLineText(record: LogRecord): string {
  if (typeof record.body === "string" && record.body !== "") {
    return record.body;
  }
  return record.raw ?? "";
}

function firstScalar(attrs: Attributes, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    const text = scalarText(value);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function scalarText(value: AnyValue | undefined): string | undefined {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}
