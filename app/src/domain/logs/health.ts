import type { AnyValue, Attributes } from "./any-value.ts";

// Last path segment of an HTTP probe. Bare "live" is omitted: it is a common
// product route, while livez/liveness are probe names.
const HEALTH_SEGMENTS = new Set([
  "health",
  "healthz",
  "healthy",
  "healthcheck",
  "health-check",
  "ready",
  "readyz",
  "readiness",
  "livez",
  "liveness",
]);

const REQUEST_PATH_KEYS = [
  "http.target",
  "url.path",
  "http.route",
  "path",
  "route",
  "request_uri",
  "uri",
  "url",
  "request_path",
  "api_url",
  "request",
] as const;

const REQUEST_METHOD_KEYS = ["http.request.method", "http.method", "method", "request_method", "verb"] as const;

const REQUEST_STATUS_KEYS = [
  "http.status_code",
  "http.response.status_code",
  "status",
  "status_code",
  "response_status",
  "grpc_status",
  "grpc-status",
] as const;

const GRPC_ATTR_KEYS = ["grpc.method", "rpc.method", "rpc.service", "grpc.service", "grpc.method_name", "method"] as const;

const HTTP_METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";

const QUOTED_ACCESS = new RegExp(`"(?:${HTTP_METHODS})\\s+(\\S+)\\s+HTTP\\/[\\d.]+"`, "gi");

const METHOD_PATH = new RegExp(`(?:^|[\\s:])(?:${HTTP_METHODS})\\s+["']?(\\/[^"'\\s?#]+)`, "gi");

const GRPC_HEALTH = /grpc\.health\.v1\.health\b/i;

const SUPERVISOR_HEALTH = /^health (?:HEALTHY|UNHEALTHY|UNKNOWN)\b/i;

const SUPERVISOR_START_PERIOD = /^health check still in start period\b/i;

export type HealthLogInput = {
  source: string;
  body: AnyValue;
  attributes: Attributes;
  raw?: string;
};

// Supervisor probe lines, plus request logs of a health endpoint on HTTP
// (the service's own access log or the proxy) and gRPC Health/Check|Watch.
export function isHealthCheckLog(record: HealthLogInput): boolean {
  if (record.source === "health") {
    return true;
  }
  const text = healthLogText(record);
  if (SUPERVISOR_HEALTH.test(text) || SUPERVISOR_START_PERIOD.test(text)) {
    return true;
  }
  if (attributesIndicateHealthRequest(record.attributes)) {
    return true;
  }
  return textIndicatesHealthRequest(text);
}

function healthLogText(record: HealthLogInput): string {
  const parts: string[] = [];
  if (typeof record.body === "string" && record.body !== "") {
    parts.push(record.body);
  } else if (record.body !== undefined && record.body !== null && typeof record.body === "object") {
    parts.push(JSON.stringify(record.body));
  }
  if (record.raw !== undefined && record.raw !== "") {
    parts.push(record.raw);
  }
  return parts.join("\n");
}

function attributesIndicateHealthRequest(attrs: Attributes): boolean {
  if (grpcAttributeIsHealth(attrs)) {
    return true;
  }
  const shaped = attrPresent(attrs, REQUEST_METHOD_KEYS) || attrPresent(attrs, REQUEST_STATUS_KEYS);
  if (!shaped) {
    return false;
  }
  for (const key of REQUEST_PATH_KEYS) {
    const value = attrText(attrs, key);
    if (value !== undefined && isHealthTarget(value)) {
      return true;
    }
  }
  return false;
}

function grpcAttributeIsHealth(attrs: Attributes): boolean {
  for (const key of GRPC_ATTR_KEYS) {
    const value = attrText(attrs, key);
    if (value !== undefined && GRPC_HEALTH.test(value)) {
      return true;
    }
  }
  const service = attrText(attrs, "rpc.service") ?? attrText(attrs, "grpc.service") ?? "";
  const method = attrText(attrs, "rpc.method") ?? attrText(attrs, "grpc.method") ?? "";
  return service !== "" && method !== "" && GRPC_HEALTH.test(`${service}/${method}`);
}

function textIndicatesHealthRequest(text: string): boolean {
  if (text === "") {
    return false;
  }
  if (GRPC_HEALTH.test(text)) {
    return true;
  }
  return accessTargetIsHealth(QUOTED_ACCESS, text) || accessTargetIsHealth(METHOD_PATH, text);
}

function accessTargetIsHealth(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    if (target !== undefined && isHealthPath(target)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  pattern.lastIndex = 0;
  return false;
}

function isHealthTarget(value: string): boolean {
  if (GRPC_HEALTH.test(value)) {
    return true;
  }
  if (isHealthPath(value)) {
    return true;
  }
  return accessTargetIsHealth(QUOTED_ACCESS, value) || accessTargetIsHealth(METHOD_PATH, value);
}

export function isHealthPath(value: string): boolean {
  if (GRPC_HEALTH.test(value)) {
    return true;
  }
  const path = pathOnly(value);
  if (path === "") {
    return false;
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  const last = segments[segments.length - 1]?.toLowerCase() ?? "";
  return HEALTH_SEGMENTS.has(last);
}

function pathOnly(value: string): string {
  const cut = value.trim().search(/[?#\s]/);
  const head = cut >= 0 ? value.trim().slice(0, cut) : value.trim();
  if (head === "") {
    return "";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(head)) {
    return pathnameFromUrl(head);
  }
  const hostPath = /^(?:[\w.-]+|\[[^\]]+\])(?::\d+)?(\/.*)$/.exec(head);
  if (hostPath?.[1]) {
    return hostPath[1];
  }
  return head.startsWith("/") ? head : "";
}

function pathnameFromUrl(value: string): string {
  try {
    return new URL(value).pathname;
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    const scheme = value.indexOf("//");
    const slash = scheme >= 0 ? value.indexOf("/", scheme + 2) : -1;
    return slash >= 0 ? value.slice(slash) : "";
  }
}

function attrPresent(attrs: Attributes, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (attrText(attrs, key) !== undefined) {
      return true;
    }
  }
  return false;
}

function attrText(attrs: Attributes, key: string): string | undefined {
  const value = attrs[key];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}
