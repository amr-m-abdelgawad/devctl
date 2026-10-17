import type { AnyValue, Attributes, LogIngest, LogRecord } from "./types.ts";

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
// Fixed per-span cost: the span, its status, attribute, event, link and
// resource containers, and its entries in the trace and request-id indexes.
// A proxy request's span measures a little under this in the heap.
const SPAN_OVERHEAD_BYTES = 768;
// A link's two ids and its object.
const LINK_BYTES = 96;

/**
 * Approximate size of a record in memory and on the wire. An ASCII string
 * counts one byte per UTF-16 unit, which is exact in memory and in UTF-8. A
 * longer string with anything beyond ASCII counts two: JSC stores it as
 * UTF-16 once any unit is above 0xFF, and its UTF-8 form is at least that
 * large for CJK text. Structured bodies and attributes are walked up to a
 * fixed budget.
 */
export function approxRecordBytes(record: LogRecord): number {
  return approxBytes(record, record.body);
}

/** The same estimate for a record not built yet, whose message becomes its body. */
export function approxIngestBytes(ingest: LogIngest): number {
  return approxBytes(ingest, ingest.body ?? ingest.message ?? "");
}

function approxBytes(fields: Pick<LogIngest, "service" | "source" | "raw" | "attributes" | "resource">, body: AnyValue): number {
  const budget = { left: WALK_BUDGET };
  return (
    RECORD_OVERHEAD_BYTES +
    stringBytes(fields.service) +
    stringBytes(fields.source) +
    (fields.raw === undefined ? 0 : stringBytes(fields.raw)) +
    valueBytes(body, budget) +
    attributesBytes(fields.attributes, budget) +
    attributesBytes(fields.resource, budget)
  );
}

/** What `approxSpanBytes` reads of a span. */
type SizedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: { message?: string };
  attributes: Attributes;
  events: readonly { name: string; attributes: Attributes }[];
  links: readonly unknown[];
  resource: Attributes;
};

/**
 * Approximate size of a span as the trace store holds it. A span is sized
 * once, when it arrives, and one request carries few of them, so the walk has
 * no budget: a prompt or a stack trace is counted wherever it sits, in an
 * attribute or in an event.
 */
export function approxSpanBytes(span: SizedSpan): number {
  const budget = { left: Number.POSITIVE_INFINITY };
  let total =
    SPAN_OVERHEAD_BYTES +
    stringBytes(span.name) +
    span.traceId.length +
    span.spanId.length +
    (span.parentSpanId?.length ?? 0) +
    (span.status.message === undefined ? 0 : stringBytes(span.status.message)) +
    span.links.length * LINK_BYTES +
    attributesBytes(span.attributes, budget) +
    attributesBytes(span.resource, budget);
  for (const event of span.events) {
    total += ENTRY_OVERHEAD_BYTES + stringBytes(event.name) + attributesBytes(event.attributes, budget);
  }
  return total;
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
