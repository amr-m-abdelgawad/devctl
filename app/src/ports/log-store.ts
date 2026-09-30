import type { ServiceLogConfig } from "../domain/config/types.ts";
import type { LogFacets, LogFilter, LogIngest, LogPage, LogPageRequest, LogParser, LogRecord } from "../domain/logs/logs.ts";
import type { LogSnapshot } from "../domain/status.ts";

export type { LogSnapshot };

export type LogStore = {
  append(event: LogIngest): void;
  query(filter: LogFilter): Promise<LogRecord[]>;
  queryPage(filter: LogFilter, page?: LogPageRequest): Promise<LogPage>;
  /** One page of a persisted session's history, by plain-seq cursors. With no cursor, its newest matches. */
  historyPage?(session: string, filter: LogFilter, page?: LogPageRequest): Promise<LogPage>;
  queryFacets(filter: LogFilter): Promise<LogFacets>;
  snapshot(): LogSnapshot;
  exportTo(path: string, filter: LogFilter): Promise<void>;
  setParsers(parsers: LogParser[], pluginPaths?: readonly string[], repoRoot?: string): void;
  setServiceLogs(logs: Record<string, ServiceLogConfig>): void;
  setSecrets(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void;
  close(): Promise<void>;
  /** True when the pipeline cannot accept more bytes until the spool drains. */
  ingestPaused?(): boolean;
  /** Raw service output. False means the caller must retry this chunk. `end` (with no bytes) finishes the stream. */
  ingestChunk?(chunk: { service: string; stream: string; pid: number; readAtMs: number; bytes: Uint8Array; end?: boolean }): boolean;
  flush?(): Promise<void>;
  setMemoryBudget?(bytes: number): void;
  setIngestShed?(shed: boolean): void;
  pipelineStats?(): LogSnapshot["pipeline"];
  /** True while a worker thread holds the ring. A store without it runs on the caller's thread. */
  usesWorker?(): boolean;
};
