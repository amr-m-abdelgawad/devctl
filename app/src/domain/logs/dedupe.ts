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
  return { ...survivor, body };
}

function stringBody(body: AnyValue): string {
  return typeof body === "string" ? body : "";
}
