import { Detector, REDACTED_VALUE } from "../../shared/redaction.ts";
import { MAX_ANY_VALUE_DEPTH, MAX_ARRAY_ITEMS, MAX_ATTRIBUTE_KEYS, type AnyValue, type Attributes } from "./any-value.ts";
import type { LogRecord } from "./types.ts";
import type { Span } from "../telemetry/types.ts";

const SECRET_ATTR_NAMES = new Set([
  "authorization",
  "password",
  "passwd",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "token",
  "secret",
  "access_token",
  "refresh_token",
  "private_key",
  "client_secret",
]);

function isSecretKey(detector: Detector, keyHint: string): boolean {
  if (keyHint === "") {
    return false;
  }
  if (detector.isSecretName(keyHint)) {
    return true;
  }
  const last = keyHint.split(/[./:_-]/).filter((part) => part !== "").pop() ?? keyHint;
  return detector.isSecretName(last) || SECRET_ATTR_NAMES.has(last.toLowerCase());
}

export function redactAnyValue(detector: Detector, value: AnyValue, keyHint = "", depth = 0): AnyValue {
  if (depth >= MAX_ANY_VALUE_DEPTH) {
    return REDACTED_VALUE;
  }
  if (isSecretKey(detector, keyHint)) {
    return REDACTED_VALUE;
  }
  if (typeof value === "string") {
    return detector.redactText(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactAnyValue(detector, item, keyHint, depth + 1));
  }
  const out: { [k: string]: AnyValue } = {};
  const entries = Object.entries(value).slice(0, MAX_ATTRIBUTE_KEYS);
  for (const [key, item] of entries) {
    out[key] = redactAnyValue(detector, item, key, depth + 1);
  }
  return out;
}

export function redactAttributes(detector: Detector, attrs: Attributes): Attributes {
  const out: Attributes = {};
  const entries = Object.entries(attrs).slice(0, MAX_ATTRIBUTE_KEYS);
  for (const [key, value] of entries) {
    out[key] = redactAnyValue(detector, value, key);
  }
  return out;
}

export function redactLogRecord(detector: Detector, record: LogRecord): LogRecord {
  return {
    ...record,
    body: redactAnyValue(detector, record.body),
    attributes: redactAttributes(detector, record.attributes),
    resource: {
      ...redactAttributes(detector, record.resource),
      "service.name": record.resource["service.name"],
    },
    raw: record.raw === undefined ? undefined : detector.redactText(record.raw),
    identity: record.identity,
  };
}

export function redactSpan(detector: Detector, span: Span): Span {
  return {
    ...span,
    attributes: redactAttributes(detector, span.attributes),
    events: span.events.map((event) => ({
      ...event,
      attributes: redactAttributes(detector, event.attributes),
    })),
    resource: {
      ...redactAttributes(detector, span.resource),
      "service.name": span.resource["service.name"],
    },
    status: {
      ...span.status,
      message: span.status.message === undefined ? undefined : detector.redactText(span.status.message),
    },
  };
}
