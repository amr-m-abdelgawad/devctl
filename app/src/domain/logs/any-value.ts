export type AnyValue = string | number | boolean | null | AnyValue[] | { [k: string]: AnyValue };
export type Attributes = Record<string, AnyValue>;

export const MAX_ANY_VALUE_DEPTH = 8;
export const MAX_ATTRIBUTE_KEYS = 64;
export const MAX_ARRAY_ITEMS = 32;
// Per-string cap, matching the stdout lane's MAX_LOG_LINE_CHARS, so an OTLP body
// or attribute value (which bypasses line parsing) cannot store megabytes each.
export const MAX_ANY_VALUE_STRING_CHARS = 16 * 1024;

function capString(value: string): string {
  return value.length > MAX_ANY_VALUE_STRING_CHARS ? value.slice(0, MAX_ANY_VALUE_STRING_CHARS) : value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceAnyValue(value: unknown, depth = 0): AnyValue {
  if (depth >= MAX_ANY_VALUE_DEPTH) {
    return truncateScalar(value);
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return capString(value);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => coerceAnyValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: { [k: string]: AnyValue } = {};
    const entries = Object.entries(value).slice(0, MAX_ATTRIBUTE_KEYS);
    for (const [key, item] of entries) {
      out[key] = coerceAnyValue(item, depth + 1);
    }
    return out;
  }
  return truncateScalar(value);
}

export function coerceAttributes(value: unknown): Attributes {
  if (!isPlainObject(value)) {
    return {};
  }
  const out: Attributes = {};
  const entries = Object.entries(value).slice(0, MAX_ATTRIBUTE_KEYS);
  for (const [key, item] of entries) {
    out[key] = coerceAnyValue(item);
  }
  return out;
}

export function stringifyAnyValue(value: AnyValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function anyValueSearchText(value: AnyValue, depth = 0): string {
  if (depth >= MAX_ANY_VALUE_DEPTH) {
    return stringifyAnyValue(value);
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return stringifyAnyValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => anyValueSearchText(item, depth + 1)).join(" ");
  }
  return Object.entries(value)
    .map(([key, item]) => `${key} ${anyValueSearchText(item, depth + 1)}`)
    .join(" ");
}

export function formatLogfmt(attrs: Record<string, AnyValue>, limit = MAX_ATTRIBUTE_KEYS): string {
  const parts: string[] = [];
  const entries = Object.entries(attrs).slice(0, limit);
  for (const [key, value] of entries) {
    parts.push(`${key}=${quoteLogfmt(stringifyAnyValue(value))}`);
  }
  return parts.join(" ");
}

function quoteLogfmt(value: string): string {
  if (value === "" || /[\s="]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function truncateScalar(value: unknown): string {
  if (typeof value === "string") {
    return capString(value);
  }
  try {
    return capString(JSON.stringify(value) ?? String(value));
  } catch {
    return capString(String(value));
  }
}
