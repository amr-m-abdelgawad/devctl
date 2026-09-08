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

export type LogStore = {
  append(event: LogEntry): void;
  query(filter: LogFilter): LogEvent[];
  queryPage(filter: LogFilter, page?: LogPageRequest): LogPage;
  queryFacets(filter: LogFilter): LogFacets;
  snapshot(): { total: number; errors: number; counts: Record<string, number> };
  exportTo(path: string, filter: LogFilter): void;
  setParsers(parsers: LogParser[]): void;
  close(): Promise<void>;
};
