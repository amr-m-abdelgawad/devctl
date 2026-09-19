import type { ServiceLogConfig } from "../domain/config/types.ts";
import type { LogFacets, LogFilter, LogIngest, LogPage, LogPageRequest, LogParser, LogRecord } from "../domain/logs/logs.ts";
import type { LogSnapshot } from "../domain/status.ts";

export type { LogSnapshot };

export type LogStore = {
  append(event: LogIngest): void;
  query(filter: LogFilter): Promise<LogRecord[]>;
  queryPage(filter: LogFilter, page?: LogPageRequest): Promise<LogPage>;
  queryFacets(filter: LogFilter): Promise<LogFacets>;
  snapshot(): LogSnapshot;
  exportTo(path: string, filter: LogFilter): Promise<void>;
  setParsers(parsers: LogParser[], pluginPaths?: readonly string[], repoRoot?: string): void;
  setServiceLogs(logs: Record<string, ServiceLogConfig>): void;
  setSecrets(extraMarkers: string[], extraPatterns: string[]): void;
  close(): Promise<void>;
};
