import { isErrorSeverity, type LogRecord } from "../../domain/logs/logs.ts";

export function estimateRecordBytes(event: LogRecord): number {
  const body = typeof event.body === "string" ? event.body.length : 64;
  const raw = event.raw?.length ?? 0;
  const service = event.service.length;
  return body + raw + service + 256;
}

/**
 * Count-capped ring that can also evict by a byte budget. Eviction is by
 * count when `maxBytes` is 0, which is the historical behavior.
 */
export class LogRing {
  private events: LogRecord[] = [];
  private eventStart = 0;
  private bytes = 0;
  readonly counts: Record<string, number> = {};
  errors = 0;

  constructor(
    readonly maxCount: number,
    private maxBytes: number,
  ) {}

  get length(): number {
    return this.events.length;
  }

  byteSize(): number {
    return this.bytes;
  }

  setMaxBytes(maxBytes: number): LogRecord[] {
    this.maxBytes = maxBytes;
    return this.evictOverflow();
  }

  push(event: LogRecord): LogRecord[] {
    const evicted: LogRecord[] = [];
    if (this.events.length < this.maxCount) {
      this.events.push(event);
      this.note(event, 1);
    } else {
      const removed = this.events[this.eventStart];
      if (removed) {
        evicted.push(removed);
        this.note(removed, -1);
      }
      this.events[this.eventStart] = event;
      this.note(event, 1);
      this.eventStart = (this.eventStart + 1) % this.maxCount;
    }
    evicted.push(...this.evictOverflow());
    return evicted;
  }

  replace(seq: number, updated: LogRecord): boolean {
    const count = this.events.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.eventStart + offset) % count;
      const current = this.events[index];
      if (current?.seq === seq) {
        this.note(current, -1);
        this.events[index] = updated;
        this.note(updated, 1);
        return true;
      }
    }
    return false;
  }

  forEach(visit: (event: LogRecord) => void): void {
    const count = this.events.length;
    for (let offset = 0; offset < count; offset += 1) {
      const event = this.events[(this.eventStart + offset) % count];
      if (event) {
        visit(event);
      }
    }
  }

  private evictOverflow(): LogRecord[] {
    if (this.maxBytes <= 0 || this.bytes <= this.maxBytes) {
      return [];
    }
    const ordered: LogRecord[] = [];
    this.forEach((event) => {
      ordered.push(event);
    });
    const evicted: LogRecord[] = [];
    while (ordered.length > 1 && this.bytes > this.maxBytes) {
      const removed = ordered.shift();
      if (removed === undefined) {
        break;
      }
      this.note(removed, -1);
      evicted.push(removed);
    }
    this.events = ordered;
    this.eventStart = 0;
    return evicted;
  }

  private note(event: LogRecord, delta: number): void {
    this.bytes += delta * estimateRecordBytes(event);
    if (this.bytes < 0) {
      this.bytes = 0;
    }
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
