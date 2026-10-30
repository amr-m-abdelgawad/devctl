import type { McpHost } from "./mcp-host.ts";
import type { IdentitySnapshot, ReloadResult, StartRequest } from "../domain/status.ts";
import type { PortHolder } from "../domain/net/ports.ts";
import type { Plan } from "../domain/service/services.ts";

export type ConfigDocument = { path: string; text: string; revision: string; exists: boolean };
export type ConfigSaveResult = {
  saved: boolean;
  issues: string[];
  conflict?: boolean;
  document?: ConfigDocument;
  reload?: ReloadResult;
  reload_error?: string;
};
export type WebConfigFiles = {
  read(path: string): ConfigDocument;
  replace(path: string, text: string, revision: string): ConfigDocument | undefined;
};
export type WebLoginState = {
  id: string;
  phase: "starting" | "awaiting_code" | "finishing" | "succeeded" | "failed" | "cancelled";
  url?: string;
  error?: string;
};
export type WebAuthentication = {
  start(): WebLoginState;
  status(): WebLoginState | undefined;
  submit(id: string, code: string): WebLoginState;
  cancel(id: string): void;
  logout(): Promise<void>;
  dispose(): void;
};
export type WebAuthFactory = (changed: () => Promise<void>) => WebAuthentication;

/** Operator-only capabilities. These are deliberately separate from coding-agent MCP tools. */
export type WebHost = McpHost & {
  operator?: {
    readConfig(): ConfigDocument;
    saveConfig(text: string, revision: string): Promise<ConfigSaveResult>;
    auth?: WebAuthentication;
    refreshAuth(): Promise<IdentitySnapshot>;
    invalidateAuth(): Promise<void>;
    freePort(holder: PortHolder): Promise<"stopped" | "already-free">;
    mcpConnection(): { url: string; token: string };
    rotateMcp(): Promise<void>;
    setMcpTools(disabled: string[]): Promise<string[]>;
    bootstrapLogs(): string;
    planStart(req: StartRequest): Plan;
    planStop(services: string[]): Plan;
    shutdown(stopServices: boolean): void;
  };
};

export type WebListener = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  listenPort(): number;
  address(): string;
};

export type WebListenerFactory = (opts: {
  port: number;
  host?: string;
  token: string;
  hostApi: WebHost;
  onEvent: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}) => WebListener;

export type { McpHost };
