import { COALESCE_MS, LANE_BATCH_BYTES, LANE_BATCH_RECORDS, LANE_CREDIT_BYTES, LANE_MAX_BYTES, LANE_PAUSE_BYTES } from "../../domain/logs/budgets.ts";
import type { LogIngest } from "../../domain/logs/logs.ts";
import { approxIngestBytes } from "../../domain/logs/size.ts";

/** A structured append on its way to the log worker, with its event time. */
export type LaneItem = { id: number; atMs: number; event: LogIngest };

type Held = LaneItem & { bytes: number };

const COMPACT_AFTER = 1_024;

/**
 * Structured appends (hooks, tasks, exec, the proxy, OTLP, the daemon's own
 * lines) on their way to the log worker, each stamped when it was appended.
 * They leave in batches at most once a tick, within a credit window of sent
 * but unacked bytes, and stay held until the worker acks them by id, so a
 * replacement worker or the in-process store gets exactly the unacked ones.
 */
export class AppendLane {
  private items: Held[] = [];
  // items[head] is the oldest unacked; items[sent] the oldest not yet sent.
  private head = 0;
  private sent = 0;
  private sentBytes = 0;
  private heldBytes = 0;
  private nextId = 1;
  private sentAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Appends turned away because the lane was full. */
  lost = 0;

  /** `send` returns false when the batch could not be posted; the lane then stops sending. */
  constructor(private readonly send: (items: LaneItem[]) => boolean) {}

  push(event: LogIngest, atMs: number): void {
    const bytes = approxIngestBytes(event);
    if (this.heldBytes + bytes > LANE_MAX_BYTES) {
      this.lost += 1;
      return;
    }
    this.items.push({ id: this.nextId, atMs, event, bytes });
    this.nextId += 1;
    this.heldBytes += bytes;
    this.schedule();
  }

  /** True while so much is held that producers able to wait should (OTLP answers 503). */
  backlogged(): boolean {
    return this.heldBytes >= LANE_PAUSE_BYTES;
  }

  heldCount(): number {
    return this.items.length - this.head;
  }

  /** Sends everything held now, past the credit window, so a request posted next is ordered after it. */
  sendAll(): void {
    this.clearTimer();
    this.sendBatches(Number.POSITIVE_INFINITY);
  }

  /** The worker has taken every append up to and including `id`. */
  ack(id: number): void {
    while (this.head < this.sent && this.items[this.head]!.id <= id) {
      const item = this.items[this.head]!;
      this.sentBytes -= item.bytes;
      this.heldBytes -= item.bytes;
      this.head += 1;
    }
    if (this.head >= COMPACT_AFTER && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.sent -= this.head;
      this.head = 0;
    }
    this.schedule();
  }

  /** Every unacked append, oldest first; the lane is left empty. */
  takeUnacked(): LaneItem[] {
    this.clearTimer();
    const unacked = this.items.slice(this.head).map(({ id, atMs, event }) => ({ id, atMs, event }));
    this.items = [];
    this.head = 0;
    this.sent = 0;
    this.sentBytes = 0;
    this.heldBytes = 0;
    return unacked;
  }

  /** Counts every unacked append as not sent, for a worker that never got them. */
  resend(): void {
    this.sent = this.head;
    this.sentBytes = 0;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.sent >= this.items.length) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sendBatches(LANE_CREDIT_BYTES);
    }, Math.max(0, this.sentAt + COALESCE_MS - Date.now()));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // An append goes while it fits the window, or alone into an empty one so
  // that one larger than the window still goes; the rest waits for acks.
  private sendBatches(creditBytes: number): void {
    while (this.sent < this.items.length) {
      const start = this.sent;
      let bytes = 0;
      while (this.sent < this.items.length && this.sent - start < LANE_BATCH_RECORDS) {
        const next = this.items[this.sent]!;
        if (this.sent > start && bytes + next.bytes > LANE_BATCH_BYTES) {
          break;
        }
        if (this.sentBytes + bytes > 0 && this.sentBytes + bytes + next.bytes > creditBytes) {
          break;
        }
        bytes += next.bytes;
        this.sent += 1;
      }
      if (this.sent === start) {
        return;
      }
      this.sentBytes += bytes;
      this.sentAt = Date.now();
      const batch = this.items.slice(start, this.sent).map(({ id, atMs, event }) => ({ id, atMs, event }));
      if (!this.send(batch)) {
        return;
      }
    }
  }
}
