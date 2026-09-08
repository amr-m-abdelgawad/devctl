import type { DevctlConfig } from "../domain/config/types.ts";
import type { Report } from "../domain/doctor/types.ts";
import type { LogFilter, LogPage, LogPageRequest } from "../domain/logs/logs.ts";
import type { ReloadResult, StartRequest, StatusSnapshot } from "../domain/status.ts";

export type McpHost = {
  status(): StatusSnapshot;
  logsPage(req: LogFilter & LogPageRequest): LogPage | Promise<LogPage>;
  config(): DevctlConfig;
  validateConfigText(text: string): string[];
  start(req: StartRequest): Promise<unknown>;
  stop(names: string[]): Promise<void>;
  restart(names: string[], cascade?: boolean): Promise<void>;
  reload(): Promise<ReloadResult>;
  doctor(): Promise<Report>;
  exec?(service: string, command: string[], printEnv?: boolean): Promise<{ service: string; code: number; stdout: string; stderr: string; environment?: Record<string, string> }>;
  runTask(name: string): Promise<{ task: string; code: number; stdout: string; stderr: string }>;
  startProxy(): Promise<void>;
  stopProxy(): Promise<void>;
};

export type McpListener = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  listenPort(): number;
  address(): string;
};

export type McpListenerFactory = (opts: {
  port: number;
  token: string;
  hostApi: McpHost;
  onEvent: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  disabledTools: () => readonly string[];
}) => McpListener;
