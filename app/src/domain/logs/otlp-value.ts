import { coerceAnyValue, isPlainObject, type AnyValue, type Attributes } from "./any-value.ts";

export function decodeOtlpAnyValue(value: unknown): AnyValue {
  if (!isPlainObject(value)) {
    return coerceAnyValue(value);
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue;
  }
  if (value.intValue !== undefined && value.intValue !== null) {
    // OTLP/JSON encodes int64 as a string; only keep it as a JS number when it
    // is exactly representable, otherwise preserve the original string so a
    // large id is not silently rounded past Number.MAX_SAFE_INTEGER.
    const n = Number(value.intValue);
    if (Number.isSafeInteger(n)) {
      return n;
    }
    return typeof value.intValue === "string" ? value.intValue : String(value.intValue);
  }
  if (typeof value.doubleValue === "number") {
    return value.doubleValue;
  }
  if (typeof value.boolValue === "boolean") {
    return value.boolValue;
  }
  if (typeof value.bytesValue === "string") {
    return value.bytesValue;
  }
  const arrayValues = isPlainObject(value.arrayValue) ? value.arrayValue.values : undefined;
  if (Array.isArray(arrayValues)) {
    return arrayValues.map((item) => decodeOtlpAnyValue(item));
  }
  const kvValues = isPlainObject(value.kvlistValue) ? value.kvlistValue.values : undefined;
  if (Array.isArray(kvValues)) {
    return flattenOtlpAttributes(kvValues);
  }
  return coerceAnyValue(value);
}

export function isOtlpAttributeList(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((item) => isPlainObject(item) && typeof item.key === "string" && item.value !== undefined);
}

export function flattenOtlpAttributes(value: unknown): Attributes {
  const out: Attributes = {};
  if (!isOtlpAttributeList(value)) {
    return out;
  }
  for (const item of value) {
    const key = item.key;
    if (typeof key === "string" && key !== "") {
      out[key] = decodeOtlpAnyValue(item.value);
    }
  }
  return out;
}

export function resourceFromOtlp(value: unknown, fallbackService: string): { "service.name": string; [k: string]: AnyValue } {
  const attrs = isPlainObject(value) ? flattenOtlpAttributes(value.attributes) : {};
  const name = typeof attrs["service.name"] === "string" && attrs["service.name"] !== "" ? attrs["service.name"] : fallbackService;
  return { ...attrs, "service.name": name };
}

export function scopeFromOtlp(value: unknown): { name: string; version?: string } | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const name = typeof value.name === "string" ? value.name : "";
  if (name === "") {
    return undefined;
  }
  const version = typeof value.version === "string" && value.version !== "" ? value.version : undefined;
  return { name, version };
}

// Contract: *UnixNano values are held as JS numbers, so precision is bounded to
// roughly milliseconds — current epoch-nanos (~1.79e18) far exceed
// Number.MAX_SAFE_INTEGER, so the low-order digits are not exact. Consumers must
// treat these as millisecond-granular timestamps (fine for display, ordering,
// and durations >= ~1ms); do not rely on exact-nanosecond equality.
export function unixNanoFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return undefined;
}
