import type { LogEvent, LogFacets, LogFilter, LogPage, LogPageRequest, LogParser } from "../domain/logs/logs.ts";

export type LogEntry = {
  timestamp: string;
  service: string;
  source: string;
  stream?: "stdout" | "stderr";
  level: string;
  message: string;
  pid: number;
  request_id?: string;
  identity?: string;
};

export type LogSnapshot = { total: number; errors: number; counts: Record<string, number> };

export type LogStore = {
  append(event: LogEntry): void;
  query(filter: LogFilter): Promise<LogEvent[]>;
  queryPage(filter: LogFilter, page?: LogPageRequest): Promise<LogPage>;
  queryFacets(filter: LogFilter): Promise<LogFacets>;
  snapshot(): LogSnapshot;
  exportTo(path: string, filter: LogFilter): Promise<void>;
  setParsers(parsers: LogParser[], pluginPaths?: readonly string[]): void;
  setSecrets(extraMarkers: string[], extraPatterns: string[]): void;
  close(): Promise<void>;
};
