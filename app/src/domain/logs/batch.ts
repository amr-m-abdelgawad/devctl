import type { LogRecord } from "./types.ts";
import type { LogSnapshot } from "../status.ts";
import { approxRecordBytes } from "./size.ts";

const LOG_BATCH_MS = 50;
/** A live batch carries at most this many records; older ones are counted in `skipped`. */
export const LOG_BATCH_MAX_RECORDS = 500;
/** A live batch carries at most about this many bytes of records. */
export const LOG_BATCH_MAX_BYTES = 2 * 1024 * 1024;

/** Negotiated live-log batch. Old clients keep receiving `LogReceived`. */
export type LogBatchPayload = {
  session: string;
  firstSeq: number;
  lastSeq: number;
  /** The newest records of `[firstSeq, lastSeq]`, oldest first. */
  newest: LogRecord[];
  replaced: LogRecord[];
  /** Records in `[firstSeq, lastSeq]` this batch leaves out. A client pages them by seq. */
  skipped: number;
  stats: LogSnapshot;
};

export function logBatchWire(batch: LogBatchPayload): string {
  return JSON.stringify(batch);
}

const EMPTY_STATS: LogSnapshot = { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 };

/**
 * Accumulates records, or whole batches, into one batch that keeps only the
 * newest records within the batch limits and counts the rest as skipped.
 * Each record costs O(1) amortized however many arrive before `take`.
 */
export class LogBatchBuilder {
  private records: LogRecord[] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private replaced: LogRecord[] = [];
  private skipped = 0;
  private firstSeq = 0;
  private lastSeq = 0;
  private session = "";
  private stats: LogSnapshot = EMPTY_STATS;

  get empty(): boolean {
    return this.records.length === 0 && this.replaced.length === 0 && this.skipped === 0;
  }

  add(record: LogRecord): void {
    this.noteSeq(record.seq);
    const size = approxRecordBytes(record);
    this.records.push(record);
    this.sizes.push(size);
    this.bytes += size;
    if (this.records.length >= 2 * LOG_BATCH_MAX_RECORDS || this.bytes >= 2 * LOG_BATCH_MAX_BYTES) {
      this.trim();
    }
  }

  /** Folds an earlier-built batch in: its range, its skipped count, and its records. */
  addBatch(batch: LogBatchPayload): void {
    this.session = batch.session;
    this.stats = batch.stats ?? this.stats;
    this.skipped += typeof batch.skipped === "number" ? batch.skipped : 0;
    this.noteSeq(batch.firstSeq);
    this.noteSeq(batch.lastSeq);
    for (const record of batch.newest) {
      this.add(record);
    }
    this.replaced = this.replaced.concat(batch.replaced);
    if (this.replaced.length > LOG_BATCH_MAX_RECORDS) {
      this.replaced = this.replaced.slice(-LOG_BATCH_MAX_RECORDS);
    }
  }

  take(session: string, stats: LogSnapshot): LogBatchPayload {
    this.trim();
    const newest = this.records;
    const batch: LogBatchPayload = {
      session: session === "" ? this.session : session,
      firstSeq: this.firstSeq,
      lastSeq: this.lastSeq,
      newest,
      replaced: this.replaced,
      skipped: this.skipped,
      stats,
    };
    this.records = [];
    this.sizes = [];
    this.bytes = 0;
    this.replaced = [];
    this.skipped = 0;
    this.firstSeq = 0;
    this.lastSeq = 0;
    return batch;
  }

  /** The stats of the newest batch folded in with `addBatch`. */
  latestStats(): LogSnapshot {
    return this.stats;
  }

  private noteSeq(seq: number): void {
    if (seq <= 0) {
      return;
    }
    this.firstSeq = this.firstSeq === 0 ? seq : Math.min(this.firstSeq, seq);
    this.lastSeq = Math.max(this.lastSeq, seq);
  }

  // Drops the oldest records until both limits hold, keeping at least the newest.
  private trim(): void {
    let drop = Math.max(0, this.records.length - LOG_BATCH_MAX_RECORDS);
    let bytes = this.bytes;
    for (let index = 0; index < drop; index += 1) {
      bytes -= this.sizes[index]!;
    }
    while (bytes > LOG_BATCH_MAX_BYTES && drop < this.records.length - 1) {
      bytes -= this.sizes[drop]!;
      drop += 1;
    }
    if (drop === 0) {
      return;
    }
    this.records = this.records.slice(drop);
    this.sizes = this.sizes.slice(drop);
    this.bytes = bytes;
    this.skipped += drop;
  }
}

/**
 * Publishes at most one live batch per 50 ms. A batch holds the newest records
 * only, so a flood costs a bounded amount per batch however fast lines arrive.
 */
export class LogBatcher {
  private readonly builder = new LogBatchBuilder();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly session: string,
    private readonly stats: () => LogSnapshot,
    private readonly publish: (batch: LogBatchPayload) => void,
  ) {}

  push(event: LogRecord): void {
    this.builder.add(event);
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => this.flush(), LOG_BATCH_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.builder.empty) {
      return;
    }
    this.publish(this.builder.take(this.session, this.stats()));
  }
}
