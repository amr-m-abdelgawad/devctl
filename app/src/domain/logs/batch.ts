import type { LogRecord } from "./types.ts";
import type { LogSnapshot } from "../status.ts";

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
