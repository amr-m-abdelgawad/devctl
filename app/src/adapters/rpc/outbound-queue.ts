import { LogBatchBuilder, type LogBatchPayload } from "../../domain/logs/batch.ts";
import { approxRecordBytes } from "../../domain/logs/size.ts";
import type { LogRecord } from "../../domain/logs/types.ts";
import { LogBatch, LogReceived, ProxyRequest } from "../../shared/events.ts";
import type { Envelope } from "../../types.ts";

export type OutboundQueueOptions = {
  /** Legacy per-record `LogReceived` events kept for a slow reader; the oldest go first. */
  maxLegacyEvents?: number;
  maxLegacyBytes?: number;
  /** Per-request `ProxyRequest` notices kept for a slow reader; the oldest go first. */
  maxNoticeEvents?: number;
  /** Responses and state events are never dropped. Past this many unread, the reader is gone. */
  maxKeptEvents?: number;
};

const DEFAULT_MAX_LEGACY_EVENTS = 2_000;
const DEFAULT_MAX_LEGACY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_NOTICE_EVENTS = 1_000;
const DEFAULT_MAX_KEPT_EVENTS = 10_000;
const LEGACY_FALLBACK_BYTES = 256;
const COMPACT_AFTER = 1_024;

type Lane = "kept" | "batch" | "legacy" | "notice";

type Slot = { env: Envelope; lane: Lane; bytes: number };

/** Positions of one droppable lane, oldest first, so the oldest entry drops in O(1). */
class DropLane {
  private positions: number[] = [];
  private head = 0;
  bytes = 0;

  get size(): number {
    return this.positions.length - this.head;
  }

  add(position: number, bytes: number): void {
    this.positions.push(position);
    this.bytes += bytes;
  }

  /** Removes the oldest position. The caller subtracts its bytes. */
  shift(): number | undefined {
    if (this.head >= this.positions.length) {
      return undefined;
    }
    const position = this.positions[this.head];
    this.head += 1;
    if (this.head >= COMPACT_AFTER && this.head * 2 >= this.positions.length) {
      this.positions = this.positions.slice(this.head);
      this.head = 0;
    }
    return position;
  }
}

/**
 * Per-connection send queue for the supervisor's RPC server. Memory stays
 * bounded while a client is slow or suspended: live log batches merge into
 * one pending batch (newest records kept, the rest counted as skipped),
 * legacy per-record events and proxy notices drop their oldest entries, and
 * responses and state events are kept in order.
 */
export class OutboundQueue {
  private slots: (Slot | undefined)[] = [];
  // Absolute position of slots[0] and of the next slot to send.
  private base = 0;
  private next = 0;
  private kept = 0;
  private batchAt: number | undefined;
  private readonly pendingBatch = new LogBatchBuilder();
  private readonly legacy = new DropLane();
  private readonly notices = new DropLane();
  private readonly maxLegacyEvents: number;
  private readonly maxLegacyBytes: number;
  private readonly maxNoticeEvents: number;
  private readonly maxKeptEvents: number;

  constructor(options: OutboundQueueOptions = {}) {
    this.maxLegacyEvents = options.maxLegacyEvents ?? DEFAULT_MAX_LEGACY_EVENTS;
    this.maxLegacyBytes = options.maxLegacyBytes ?? DEFAULT_MAX_LEGACY_BYTES;
    this.maxNoticeEvents = options.maxNoticeEvents ?? DEFAULT_MAX_NOTICE_EVENTS;
    this.maxKeptEvents = options.maxKeptEvents ?? DEFAULT_MAX_KEPT_EVENTS;
  }

  /** Entries waiting to be sent. */
  get size(): number {
    return this.kept + (this.batchAt === undefined ? 0 : 1) + this.legacy.size + this.notices.size;
  }

  /**
   * Queues one envelope. Returns false once more responses and state events
   * are waiting than any live reader leaves unread; the caller closes the
   * connection instead of holding them.
   */
  push(env: Envelope): boolean {
    const type = env.id === undefined ? eventTypeOf(env) : undefined;
    if (type === LogBatch) {
      this.pushBatch(env);
      return true;
    }
    if (type === LogReceived) {
      this.pushDroppable(this.legacy, env, legacyBytes(env), this.maxLegacyEvents, this.maxLegacyBytes);
      return true;
    }
    if (type === ProxyRequest) {
      this.pushDroppable(this.notices, env, 0, this.maxNoticeEvents, Number.POSITIVE_INFINITY);
      return true;
    }
    this.append({ env, lane: "kept", bytes: 0 });
    this.kept += 1;
    return this.kept <= this.maxKeptEvents;
  }

  /** Removes and returns up to `max` envelopes in send order. */
  drain(max = Number.POSITIVE_INFINITY): Envelope[] {
    const out: Envelope[] = [];
    const end = this.base + this.slots.length;
    while (this.next < end && out.length < max) {
      const index = this.next - this.base;
      const slot = this.slots[index];
      this.slots[index] = undefined;
      this.next += 1;
      if (slot === undefined) {
        continue;
      }
      out.push(this.release(slot));
    }
    if (this.next - this.base >= COMPACT_AFTER && (this.next - this.base) * 2 >= this.slots.length) {
      this.slots = this.slots.slice(this.next - this.base);
      this.base = this.next;
    }
    return out;
  }

  clear(): void {
    this.drain();
    this.slots = [];
    this.base = this.next;
  }

  private release(slot: Slot): Envelope {
    switch (slot.lane) {
      case "kept":
        this.kept -= 1;
        return slot.env;
      case "legacy":
        this.legacy.shift();
        this.legacy.bytes -= slot.bytes;
        return slot.env;
      case "notice":
        this.notices.shift();
        return slot.env;
      case "batch": {
        this.batchAt = undefined;
        const payload = this.pendingBatch.take("", this.pendingBatch.latestStats());
        const event = slot.env.event as Record<string, unknown>;
        return { ...slot.env, event: { ...event, payload } };
      }
    }
  }

  // The first batch takes a place in the queue; later ones fold into it until it is sent.
  private pushBatch(env: Envelope): void {
    const payload = batchPayload(env);
    if (payload === undefined) {
      this.append({ env, lane: "kept", bytes: 0 });
      this.kept += 1;
      return;
    }
    this.pendingBatch.addBatch(payload);
    if (this.batchAt === undefined) {
      this.batchAt = this.append({ env, lane: "batch", bytes: 0 });
      return;
    }
    // Keep the newest envelope's metadata (timestamp, service) on the merged batch.
    const slot = this.slots[this.batchAt - this.base];
    if (slot !== undefined) {
      slot.env = env;
    }
  }

  private pushDroppable(lane: DropLane, env: Envelope, bytes: number, maxEvents: number, maxBytes: number): void {
    lane.add(this.append({ env, lane: lane === this.legacy ? "legacy" : "notice", bytes }), bytes);
    while (lane.size > maxEvents || (lane.bytes > maxBytes && lane.size > 1)) {
      const oldest = lane.shift();
      if (oldest === undefined) {
        return;
      }
      const index = oldest - this.base;
      const slot = this.slots[index];
      if (slot !== undefined) {
        lane.bytes -= slot.bytes;
        this.slots[index] = undefined;
      }
    }
  }

  private append(slot: Slot): number {
    const position = this.base + this.slots.length;
    this.slots.push(slot);
    return position;
  }
}

function eventTypeOf(env: Envelope): string | undefined {
  const event = env.event as { type?: unknown } | undefined;
  return typeof event?.type === "string" ? event.type : undefined;
}

function batchPayload(env: Envelope): LogBatchPayload | undefined {
  const payload = (env.event as { payload?: unknown } | undefined)?.payload;
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { newest?: unknown }).newest)) {
    return undefined;
  }
  return payload as LogBatchPayload;
}

function legacyBytes(env: Envelope): number {
  const record = (env.event as { payload?: { event?: unknown } } | undefined)?.payload?.event;
  if (typeof record !== "object" || record === null) {
    return LEGACY_FALLBACK_BYTES;
  }
  const { service, source } = record as { service?: unknown; source?: unknown };
  if (typeof service !== "string" || typeof source !== "string") {
    return LEGACY_FALLBACK_BYTES;
  }
  return approxRecordBytes(record as LogRecord);
}
