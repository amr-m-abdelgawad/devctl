import type { LogRecord } from "./types.ts";
import type { LogSnapshot } from "../status.ts";

const LOG_BATCH_MS = 50;

/** Negotiated live-log batch. Old clients keep receiving `LogReceived`. */
export type LogBatchPayload = {
  session: string;
  firstSeq: number;
  lastSeq: number;
  newest: LogRecord[];
  replaced: LogRecord[];
  stats: LogSnapshot;
};

export function logBatchWire(batch: LogBatchPayload): string {
  return JSON.stringify(batch);
}

/** Publishes at most one live batch per 50 ms. Records are kept until the timer fires. */
export class LogBatcher {
  private newest: LogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly session: string,
    private readonly stats: () => LogSnapshot,
    private readonly publish: (batch: LogBatchPayload) => void,
  ) {}

  push(event: LogRecord): void {
    this.newest.push(event);
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
    const newest = this.newest.splice(0, this.newest.length);
    const first = newest[0];
    const last = newest[newest.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    this.publish({
      session: this.session,
      firstSeq: first.seq,
      lastSeq: last.seq,
      newest,
      replaced: [],
      stats: this.stats(),
    });
  }
}
