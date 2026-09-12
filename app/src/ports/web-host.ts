import type { McpHost } from "./mcp-host.ts";

export type WebListener = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  listenPort(): number;
  address(): string;
};

export type WebListenerFactory = (opts: {
  port: number;
  hostApi: McpHost;
  onEvent: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}) => WebListener;

export type { McpHost };
