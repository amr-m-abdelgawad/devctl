import { requestIdAttribute } from "./dedupe.ts";
import { REQUEST_ID_ATTR } from "./ids.ts";
import { NANOS_PER_MS, type LogRecord } from "./types.ts";
import type { AnyValue } from "./any-value.ts";

export const PROXY_HOP_CORRELATE_WINDOW_MS = 50;
export const PROXY_LOG_SERVICE = "proxy";
export const PROXY_LOG_SOURCE = "proxy";

const GRPC_HOP_RE = /^grpc\s+(\S+)/;
const HTTP_HOP_RE = /^([A-Z]+)\s+(\S+)/;

export function isProxyHopLog(record: LogRecord): boolean {
  return record.service === PROXY_LOG_SERVICE && record.source === PROXY_LOG_SOURCE;
}

export function proxyHopNeedle(message: string): string {
  const grpc = GRPC_HOP_RE.exec(message);
  const grpcPath = grpc?.[1];
  if (grpcPath !== undefined) {
    const slash = grpcPath.lastIndexOf("/");
    return slash >= 0 ? grpcPath.slice(slash + 1) : grpcPath;
  }
  const http = HTTP_HOP_RE.exec(message);
  if (http?.[1] !== undefined && http[2] !== undefined && isHttpRequestTarget(http[2])) {
    return `${http[1]} ${http[2]}`;
  }
  return "";
}

function isHttpRequestTarget(target: string): boolean {
  return target === "*"
    || target.startsWith("/")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
    || /^[^/\s]+:\d*$/.test(target);
}

export function mentionsProxyHop(text: string, needle: string): boolean {
  if (needle === "" || text === "") {
    return false;
  }
  const haystack = text.toLowerCase();
  if (haystack.includes(needle.toLowerCase())) {
    return true;
  }
  const snake = pascalToSnake(needle);
  return snake !== needle.toLowerCase() && haystack.includes(snake);
}

export function shouldTagServiceLogWithProxyHop(proxy: LogRecord, service: LogRecord): boolean {
  if (!isProxyHopLog(proxy) || isProxyHopLog(service)) {
    return false;
  }
  const requestId = requestIdAttribute(proxy);
  if (requestId === "" || requestIdAttribute(service) !== "") {
    return false;
  }
  if (Math.abs(service.timeUnixNano - proxy.timeUnixNano) > PROXY_HOP_CORRELATE_WINDOW_MS * NANOS_PER_MS) {
    return false;
  }
  const caller = proxyCaller(proxy);
  if (caller !== "" && caller !== service.service) {
    return false;
  }
  const needle = proxyHopNeedle(recordText(proxy));
  return mentionsProxyHop(recordText(service), needle);
}

export function withRequestId(record: LogRecord, requestId: string): LogRecord {
  if (requestId === "" || requestIdAttribute(record) === requestId) {
    return record;
  }
  return {
    ...record,
    attributes: { ...record.attributes, [REQUEST_ID_ATTR]: requestId },
  };
}

function proxyCaller(record: LogRecord): string {
  const value = record.attributes.caller;
  return typeof value === "string" ? value : "";
}

function recordText(record: LogRecord): string {
  const body = anyText(record.body);
  if (body !== "") {
    return body;
  }
  return record.raw ?? "";
}

function anyText(value: AnyValue): string {
  return typeof value === "string" ? value : "";
}

function pascalToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
