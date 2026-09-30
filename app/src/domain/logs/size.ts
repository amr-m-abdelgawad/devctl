import type { AnyValue, Attributes, LogRecord } from "./types.ts";

// Fixed per-record cost: seq, timestamps, severity, ids, and the JSON framing.
const RECORD_OVERHEAD_BYTES = 256;
const ENTRY_OVERHEAD_BYTES = 16;
// A walk stops after this many values and charges a flat amount for the rest,
// so sizing one record stays cheap however deep its body is.
const WALK_BUDGET = 512;
const UNWALKED_BYTES = 16 * 1024;
// Shorter strings are counted at one byte per unit without a width check:
// the error is a few bytes, and sizing runs for every record ingested.
const WIDTH_CHECK_MIN_CHARS = 64;

/**
 * Approximate size of a record in memory and on the wire. An ASCII string
 * counts one byte per UTF-16 unit, which is exact in memory and in UTF-8. A
 * longer string with anything beyond ASCII counts two: JSC stores it as
 * UTF-16 once any unit is above 0xFF, and its UTF-8 form is at least that
 * large for CJK text. Structured bodies and attributes are walked up to a
 * fixed budget.
 */
export function approxRecordBytes(record: LogRecord): number {
  const budget = { left: WALK_BUDGET };
  return (
    RECORD_OVERHEAD_BYTES +
    stringBytes(record.service) +
    stringBytes(record.source) +
    (record.raw === undefined ? 0 : stringBytes(record.raw)) +
    valueBytes(record.body, budget) +
    attributesBytes(record.attributes, budget) +
    attributesBytes(record.resource, budget)
  );
}

/** Approximate heap size of one string, by the rule above. The capture stores size bodies with it too. */
export function stringBytes(value: string): number {
  if (value.length < WIDTH_CHECK_MIN_CHARS || Buffer.byteLength(value, "utf8") === value.length) {
    return value.length;
  }
  return 2 * value.length;
}

function attributesBytes(attributes: Attributes | undefined, budget: { left: number }): number {
  if (attributes === undefined) {
    return 0;
  }
  let total = 0;
  for (const key in attributes) {
    if (budget.left <= 0) {
      return total + UNWALKED_BYTES;
    }
    total += key.length + ENTRY_OVERHEAD_BYTES + valueBytes(attributes[key] ?? null, budget);
  }
  return total;
}

function valueBytes(value: AnyValue, budget: { left: number }): number {
  budget.left -= 1;
  if (budget.left < 0) {
    return UNWALKED_BYTES;
  }
  if (typeof value === "string") {
    return stringBytes(value);
  }
  if (value === null || typeof value !== "object") {
    return 8;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += ENTRY_OVERHEAD_BYTES + valueBytes(item, budget);
      if (budget.left < 0) {
        break;
      }
    }
    return total;
  }
  return attributesBytes(value, budget);
}
