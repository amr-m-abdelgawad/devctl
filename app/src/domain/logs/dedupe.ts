import { REQUEST_ID_ATTR } from "./ids.ts";
import { NANOS_PER_MS, type LogRecord } from "./types.ts";
import type { AnyValue } from "./any-value.ts";

export const DEFAULT_REQUEST_ID_DEDUPE_WINDOW_MS = 20;

export function requestIdAttribute(record: LogRecord): string {
  const value = record.attributes[REQUEST_ID_ATTR];
  return typeof value === "string" && value !== "" ? value : "";
}

export function dedupeLogsByRequestId<T extends LogRecord>(events: readonly T[], windowMs = DEFAULT_REQUEST_ID_DEDUPE_WINDOW_MS): T[] {
  const out: T[] = [];
  const lastIndexById = new Map<string, number>();
  for (const event of events) {
    const id = requestIdAttribute(event);
    if (id === "") {
      out.push(event);
      continue;
    }
    const prevIndex = lastIndexById.get(id);
    const prev = prevIndex !== undefined ? out[prevIndex] : undefined;
    if (prev && withinWindow(prev, event, windowMs)) {
      out[prevIndex!] = mergeRequestIdPair(prev, event);
      continue;
    }
    lastIndexById.set(id, out.length);
    out.push(event);
  }
  return out;
}

// A pair is at most the dedupe window apart in event time, but the two records
// can be committed further apart than that, so a page walk keeps this much more.
const STREAM_HOLD_SLACK_MS = 1_000;

/**
 * The same collapse for records that arrive a page at a time, oldest first.
 * `push` returns the records nothing later can merge into; the newest stretch
 * is held until the walk has moved past it, so a pair that straddles a page
 * boundary still collapses. `finish` returns what is left.
 */
export class RequestIdDeduper<T extends LogRecord> {
  private held: T[] = [];
  private newestNano = 0;

  constructor(private readonly windowMs = DEFAULT_REQUEST_ID_DEDUPE_WINDOW_MS) {}

  push(events: readonly T[]): T[] {
    const merged = dedupeLogsByRequestId(this.held.concat(events), this.windowMs);
    for (const event of events) {
      this.newestNano = Math.max(this.newestNano, event.timeUnixNano);
    }
    // Everything from the oldest record that could still gain a partner stays.
    const floor = this.newestNano - (this.windowMs + STREAM_HOLD_SLACK_MS) * NANOS_PER_MS;
    let hold = merged.length;
    for (let index = merged.length - 1; index >= 0 && merged[index]!.timeUnixNano >= floor; index -= 1) {
      if (requestIdAttribute(merged[index]!) !== "") {
        hold = index;
      }
    }
    this.held = merged.slice(hold);
    return hold === merged.length ? merged : merged.slice(0, hold);
  }

  finish(): T[] {
    const rest = this.held;
    this.held = [];
    return rest;
  }
}

function withinWindow(left: LogRecord, right: LogRecord, windowMs: number): boolean {
  return Math.abs(right.timeUnixNano - left.timeUnixNano) <= windowMs * NANOS_PER_MS;
}

function mergeRequestIdPair<T extends LogRecord>(left: T, right: T): T {
  const leftAttrs = Object.keys(left.attributes).length;
  const rightAttrs = Object.keys(right.attributes).length;
  const survivor = leftAttrs >= rightAttrs ? left : right;
  const other = survivor === left ? right : left;
  const survivorBody = stringBody(survivor.body);
  const otherBody = stringBody(other.body);
  const body = otherBody.length > survivorBody.length ? other.body : survivor.body;
  return {
    ...survivor,
    body,
    seq: left.seq,
    timestamp: left.timestamp,
    timeUnixNano: left.timeUnixNano,
    observedTimeUnixNano: left.observedTimeUnixNano,
  };
}

function stringBody(body: AnyValue): string {
  return typeof body === "string" ? body : "";
}
