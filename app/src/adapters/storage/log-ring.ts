import { isErrorSeverity, type LogRecord } from "../../domain/logs/logs.ts";
import { approxRecordBytes } from "../../domain/logs/size.ts";

// Evicted slots are cleared where they are and dropped in one copy once they
// are at least half the array, so eviction is O(1) amortized.
const COMPACT_MIN_SLOTS = 1024;

/**
 * Count-capped ring that can also evict by a byte budget. Eviction is by
 * count when `maxBytes` is 0, which is the historical behavior. Records stay
 * in seq order (a replacement keeps its seq), so lookups by seq are binary
 * searches. Each record's size is taken once, at push, and that same number
 * comes off again when the record leaves.
 */
export class LogRing {
  private events: Array<LogRecord | undefined> = [];
  private sizes: number[] = [];
  private head = 0;
  private bytes = 0;
  readonly counts: Record<string, number> = {};
  errors = 0;

  constructor(
    readonly maxCount: number,
    private maxBytes: number,
  ) {}

  get length(): number {
    return this.events.length - this.head;
  }

  byteSize(): number {
    return this.bytes;
  }

  oldestSeq(): number | undefined {
    return this.events[this.head]?.seq;
  }

  /** The record at `index`, 0 being the oldest held. */
  at(index: number): LogRecord | undefined {
    return index < 0 ? undefined : this.events[this.head + index];
  }

  /** Index of the first record whose seq is at least `seq`, or `length` when there is none. */
  lowerBound(seq: number): number {
    let lo = this.head;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid]!.seq < seq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo - this.head;
  }

  /** Returns how many records the new budget evicted. */
  setMaxBytes(maxBytes: number): number {
    this.maxBytes = maxBytes;
    return this.evictOverflow();
  }

  /** Returns how many records were evicted to make room. */
  push(event: LogRecord): number {
    let evicted = 0;
    if (this.length >= this.maxCount) {
      this.evictOldest();
      evicted += 1;
    }
    const size = approxRecordBytes(event);
    this.events.push(event);
    this.sizes.push(size);
    this.note(event, size, 1);
    return evicted + this.evictOverflow();
  }

  replace(seq: number, updated: LogRecord): boolean {
    const index = this.head + this.lowerBound(seq);
    const current = this.events[index];
    if (current === undefined || current.seq !== seq) {
      return false;
    }
    this.note(current, this.sizes[index]!, -1);
    const size = approxRecordBytes(updated);
    this.events[index] = updated;
    this.sizes[index] = size;
    this.note(updated, size, 1);
    return true;
  }

  forEach(visit: (event: LogRecord) => void): void {
    for (let index = this.head; index < this.events.length; index += 1) {
      visit(this.events[index]!);
    }
  }

  // Always keeps the newest record, however large it is.
  private evictOverflow(): number {
    let evicted = 0;
    while (this.maxBytes > 0 && this.bytes > this.maxBytes && this.length > 1) {
      this.evictOldest();
      evicted += 1;
    }
    return evicted;
  }

  private evictOldest(): void {
    const event = this.events[this.head];
    if (event !== undefined) {
      this.note(event, this.sizes[this.head]!, -1);
    }
    this.events[this.head] = undefined;
    this.head += 1;
    if (this.head >= COMPACT_MIN_SLOTS && this.head * 2 >= this.events.length) {
      this.events = this.events.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
  }

  private note(event: LogRecord, size: number, delta: number): void {
    this.bytes += delta * size;
    const next = (this.counts[event.service] ?? 0) + delta;
    if (next <= 0) {
      delete this.counts[event.service];
    } else {
      this.counts[event.service] = next;
    }
    if (isErrorSeverity(event.severityNumber)) {
      this.errors += delta;
      if (this.errors < 0) {
        this.errors = 0;
      }
    }
  }
}
