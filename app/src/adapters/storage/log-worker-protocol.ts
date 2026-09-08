import type { LogEvent, LogFacets, LogFilter, LogPage, LogPageRequest } from "../../domain/logs/logs.ts";
import type { LogEntry, LogSnapshot } from "../../ports/log-store.ts";

export type WorkerLogConfig = {
  max: number;
  persist: boolean;
  directory: string;
  sessionID: string;
  retentionDays: number;
  maxSessionLogs: number;
  extraMarkers: string[];
  extraPatterns: string[];
};

export type WorkerRequest =
  | { type: "init"; config: WorkerLogConfig }
  | { type: "append"; event: LogEntry }
  | { id: number; type: "query"; filter: LogFilter }
  | { id: number; type: "queryPage"; filter: LogFilter; page?: LogPageRequest }
  | { id: number; type: "queryFacets"; filter: LogFilter }
  | { id: number; type: "exportTo"; path: string; filter: LogFilter }
  | { type: "setPluginPaths"; paths: string[] }
  | { type: "setSecrets"; extraMarkers: string[]; extraPatterns: string[] }
  | { id: number; type: "close" };

export type WorkerRpcBody =
  | { type: "query"; filter: LogFilter }
  | { type: "queryPage"; filter: LogFilter; page?: LogPageRequest }
  | { type: "queryFacets"; filter: LogFilter }
  | { type: "exportTo"; path: string; filter: LogFilter }
  | { type: "close" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "appended"; event: LogEvent; stats: LogSnapshot }
  | { id: number; type: "result"; result: LogEvent[] | LogPage | LogFacets | null }
  | { id: number; type: "error"; error: string };
