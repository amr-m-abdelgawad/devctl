import type { AnyValue, Attributes, LogRecord } from "./types.ts";

// Fixed per-record cost: seq, timestamps, severity, ids, and the JSON framing.
const RECORD_OVERHEAD_BYTES = 256;
const ENTRY_OVERHEAD_BYTES = 16;
// A walk stops after this many values and charges a flat amount for the rest,
// so sizing one record stays cheap however deep its body is.
const WALK_BUDGET = 512;
const UNWALKED_BYTES = 16 * 1024;

/**
 * Approximate size of a record in memory and on the wire. Strings count one
 * byte per UTF-16 unit, which is exact for ASCII and within a small factor
 * otherwise; structured bodies and attributes are walked up to a fixed budget.
 */
export function approxRecordBytes(record: LogRecord): number {
  const budget = { left: WALK_BUDGET };
  return (
    RECORD_OVERHEAD_BYTES +
    record.service.length +
    record.source.length +
    (record.raw?.length ?? 0) +
    valueBytes(record.body, budget) +
    attributesBytes(record.attributes, budget) +
    attributesBytes(record.resource, budget)
  );
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
    return value.length;
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
