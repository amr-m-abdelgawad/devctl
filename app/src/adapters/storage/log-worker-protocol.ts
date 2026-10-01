import type { ServiceLogConfig } from "../../domain/config/types.ts";
import type { LogFacets, LogFilter, LogIngest, LogPage, LogPageRequest, LogRecord } from "../../domain/logs/logs.ts";
import type { LogSnapshot } from "../../ports/log-store.ts";

export type WorkerLogConfig = {
  max: number;
  persist: boolean;
  directory: string;
  sessionID: string;
  retentionDays: number;
  maxSessionLogs: number;
  extraMarkers: string[];
  extraPatterns: string[];
  redact?: boolean;
  repoKey?: string;
  maxMemoryBytes?: number;
  maxSessionBytes?: number;
  maxSpoolBytes?: number;
  maxTotalBytes?: number;
  spoolDir?: string;
  /** The seq to start from when taking over a session, past every one already published. */
  firstSeq?: number;
};

export type WorkerRequest =
  | { type: "init"; config: WorkerLogConfig }
  /** Structured appends in lane order, each with its event time; acked by the highest id. */
  | { type: "appendBatch"; items: { id: number; atMs: number; event: LogIngest }[] }
  | { id: number; type: "chunk"; service: string; stream: string; pid: number; readAtMs: number; bytes: Uint8Array; end?: boolean }
  | { type: "setMemoryBudget"; bytes: number }
  /** The daemon thread is holding output back (credit or lane full): a fold may still get older lines. */
  | { type: "setUpstreamPaused"; paused: boolean }
  | { id: number; type: "flush" }
  | { id: number; type: "query"; filter: LogFilter }
  | { id: number; type: "queryPage"; filter: LogFilter; page?: LogPageRequest }
  | { id: number; type: "historyPage"; session: string; filter: LogFilter; page?: LogPageRequest }
  | { id: number; type: "queryFacets"; filter: LogFilter }
  | { id: number; type: "exportTo"; path: string; filter: LogFilter }
  | { type: "setPluginPaths"; paths: string[]; repoRoot?: string }
  | { type: "setServiceLogs"; logs: Record<string, ServiceLogConfig> }
  | { type: "setSecrets"; extraMarkers: string[]; extraPatterns: string[]; redact?: boolean }
  | { id: number; type: "close" };

export type WorkerRpcBody =
  | { type: "query"; filter: LogFilter }
  | { type: "queryPage"; filter: LogFilter; page?: LogPageRequest }
  | { type: "historyPage"; session: string; filter: LogFilter; page?: LogPageRequest }
  | { type: "queryFacets"; filter: LogFilter }
  | { type: "exportTo"; path: string; filter: LogFilter }
  | { type: "close" }
  | { type: "flush" };

export type WorkerResponse =
  | { type: "ready" }
  /**
   * Records committed since the last batch, oldest first. `appendedUpTo` acks
   * every structured append up to that id; it travels with the records they
   * produced, so an ack never outruns them.
   */
  | { type: "appended"; events: LogRecord[]; stats: LogSnapshot; appendedUpTo?: number }
  | { id: number; type: "chunkAck"; accepted: boolean; stats: LogSnapshot }
  | { id: number; type: "result"; result: LogRecord[] | LogPage | LogFacets | null }
  | { id: number; type: "error"; error: string };
