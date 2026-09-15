import type { McpHost } from "./mcp-host.ts";
import type { HttpClientRuntime } from "./http-client.ts";

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
  hostApi: McpHost;
  httpClient?: HttpClientRuntime;
  onEvent: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}) => WebListener;

export type { McpHost };
