import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isLoopbackBindHost } from "../../domain/net/hosts.ts";
import { KindGeneral, newError, wrapError } from "../../shared/errors.ts";
import { LOCALHOST } from "../../domain/config/types.ts";
import type { McpHost } from "../../ports/mcp-host.ts";
import {
  getConfigSummary,
  getLogs,
  getRequests,
  getStatusSummary,
  getTraceTool,
  listProfiles,
  listServices,
  traceRequestTool,
} from "../mcp/tools.ts";
import { WEB_INDEX_HTML } from "./assets.generated.ts";

const JSON_CONTENT = "application/json";
const HTML_CONTENT = "text/html; charset=utf-8";
const NOSNIFF = { "X-Content-Type-Options": "nosniff" } as const;

export type WebListenOptions = {
  host: string;
  port: number;
  hostApi: McpHost;
  onEvent?: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
};

export class WebHttpServer {
  private server?: Server;
  private running = false;
  private addr = "";
  private boundPort = 0;
  private readonly opts: WebListenOptions;

  constructor(opts: WebListenOptions) {
    this.opts = opts;
  }

  address(): string {
    return this.addr;
  }

  listenPort(): number {
    return this.boundPort;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): Promise<void> {
    const host = this.opts.host || LOCALHOST;
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(newError(KindGeneral, `refusing to bind web UI to ${host}`));
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.serve(req, res);
      });
      this.server.on("error", (err) => reject(wrapError(KindGeneral, `unable to listen on ${host}:${this.opts.port}`, err)));
      this.server.listen(this.opts.port, host, () => {
        const addr = this.server?.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.addr = `${host}:${this.boundPort}`;
        this.running = true;
        this.opts.onEvent?.("INFO", `listening on ${this.addr}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    const wasRunning = this.running;
    if (!server) {
      this.running = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => {
        this.running = false;
        this.addr = "";
        this.boundPort = 0;
        this.server = undefined;
        if (wasRunning) {
          this.opts.onEvent?.("INFO", "stopped");
        }
        resolve();
      });
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, this.boundPort)) {
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET", ...NOSNIFF });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort}`);
    const path = url.pathname;
    try {
      await this.route(path, url.searchParams, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      this.opts.onEvent?.("WARN", `web ${path}: ${message}`);
      writeJson(res, 400, { error: message });
    }
  }

  private async route(path: string, query: URLSearchParams, res: ServerResponse): Promise<void> {
    const host = this.opts.hostApi;
    if (path === "/") {
      writeHtml(res, WEB_INDEX_HTML);
      return;
    }
    if (path === "/api/status") {
      writeJson(res, 200, getStatusSummary(host.status()));
      return;
    }
    if (path === "/api/services") {
      writeJson(res, 200, listServices(host.status()));
      return;
    }
    if (path === "/api/requests") {
      writeJson(res, 200, getRequests(host.status()));
      return;
    }
    if (path === "/api/config") {
      writeJson(res, 200, getConfigSummary(host.config()));
      return;
    }
    if (path === "/api/profiles") {
      writeJson(res, 200, listProfiles(host.config()));
      return;
    }
    if (path === "/api/logs") {
      writeJson(res, 200, await getLogs(host, queryArgs(query)));
      return;
    }
    const traceId = matchParam(path, "/api/trace/");
    if (traceId !== undefined) {
      writeJson(res, 200, await getTraceTool(host, { trace_id: decodeURIComponent(traceId) }));
      return;
    }
    const requestId = matchParam(path, "/api/request/");
    if (requestId !== undefined) {
      writeJson(res, 200, await traceRequestTool(host, { request_id: decodeURIComponent(requestId) }));
      return;
    }
    writeJson(res, 404, { error: "not found" });
  }
}

function hostAllowed(header: string | string[] | undefined, port: number): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const host = (raw ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function matchParam(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) {
    return undefined;
  }
  const rest = path.slice(prefix.length);
  if (rest === "" || rest.includes("/")) {
    return undefined;
  }
  return rest;
}

function queryArgs(query: URLSearchParams): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of query.entries()) {
    args[key] = value;
  }
  return args;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": JSON_CONTENT,
    "Content-Length": Buffer.byteLength(text),
    ...NOSNIFF,
  });
  res.end(text);
}

function writeHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": HTML_CONTENT,
    "Content-Length": Buffer.byteLength(html),
    ...NOSNIFF,
  });
  res.end(html);
}
