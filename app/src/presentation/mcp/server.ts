import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { KindGeneral, newError, wrapError } from "../../shared/errors.ts";
import { VERSION } from "../../version.ts";
import {
  callMcpTool,
  enabledTools,
  isKnownToolName,
  isMcpResourceUri,
  MCP_RESOURCE_URIS,
  readMcpResource,
  toolEnabled,
  type McpHost,
} from "./tools.ts";

const PROTOCOL_VERSION = "2025-03-26";
const JSON_RPC = "2.0";
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export type McpLogLevel = "INFO" | "WARN" | "ERROR";

export type McpListenOptions = {
  host: string;
  port: number;
  token: string;
  hostApi: McpHost;
  onEvent?: (level: McpLogLevel, message: string) => void;
  // Read on every request rather than captured once, so toggling a tool in
  // the TUI takes effect immediately instead of after a listener restart.
  // The supervisor owns the value; this is only a window onto it.
  disabledTools?: () => readonly string[];
};

export class McpHttpServer {
  private server?: Server;
  private running = false;
  private addr = "";
  private boundPort = 0;
  private readonly opts: McpListenOptions;

  constructor(opts: McpListenOptions) {
    this.opts = opts;
  }

  private disabled(): readonly string[] {
    return this.opts.disabledTools?.() ?? [];
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

  private emit(level: McpLogLevel, message: string): void {
    this.opts.onEvent?.(level, message);
  }

  start(): Promise<void> {
    if (!isLoopbackHost(this.opts.host)) {
      return Promise.reject(newError(KindGeneral, `refusing to bind MCP to ${this.opts.host}`));
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.serve(req, res);
      });
      this.server.on("error", (err) => reject(wrapError(KindGeneral, `unable to listen on ${this.opts.host}:${this.opts.port}`, err)));
      this.server.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server?.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.addr = `${this.opts.host}:${this.boundPort}`;
        this.running = true;
        this.emit("INFO", `listening on ${this.addr}`);
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
          this.emit("INFO", "stopped");
        }
        resolve();
      });
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (!this.authorized(req)) {
      this.emit("WARN", `rejected unauthorized request from ${remoteAddr(req)}`);
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const path = requestPath(req);
    if (path !== "/mcp") {
      json(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { Allow: "POST, OPTIONS", ...corsHeaders() });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, OPTIONS", ...corsHeaders() });
      res.end();
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      json(res, 400, rpcError(null, PARSE_ERROR, err instanceof Error ? err.message : "invalid body"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      json(res, 400, rpcError(null, PARSE_ERROR, "parse error"));
      return;
    }
    const addr = remoteAddr(req);
    if (Array.isArray(parsed)) {
      const replies = [];
      for (const item of parsed) {
        const reply = await this.dispatch(item, addr);
        if (reply !== undefined) {
          replies.push(reply);
        }
      }
      json(res, 200, replies);
      return;
    }
    const reply = await this.dispatch(parsed, addr);
    if (reply === undefined) {
      res.writeHead(202, corsHeaders());
      res.end();
      return;
    }
    json(res, 200, reply);
  }

  private authorized(req: IncomingMessage): boolean {
    if (this.opts.token === "") {
      return true;
    }
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${this.opts.token}`;
  }

  private async dispatch(raw: unknown, addr: string): Promise<unknown | undefined> {
    if (!isRecord(raw)) {
      return rpcError(null, INVALID_REQUEST, "invalid request");
    }
    const msg = raw as JsonRpcMessage;
    const id = msg.id ?? null;
    const notification = msg.id === undefined;
    if (msg.method === undefined || msg.method === "") {
      return notification ? undefined : rpcError(id, INVALID_REQUEST, "missing method");
    }
    try {
      const result = await this.handleMethod(msg.method, isRecord(msg.params) ? msg.params : {}, addr);
      if (notification) {
        return undefined;
      }
      return { jsonrpc: JSON_RPC, id, result };
    } catch (err) {
      if (notification) {
        return undefined;
      }
      const code = err instanceof McpRpcError ? err.code : INTERNAL_ERROR;
      const message = err instanceof Error ? err.message : "internal error";
      this.emit("WARN", `rpc error method=${msg.method} addr=${addr}: ${message}`);
      return rpcError(id, code, message);
    }
  }

  private async handleMethod(method: string, params: Record<string, unknown>, addr: string): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const client = extractClientInfo(params);
        this.emit("INFO", `client connected addr=${addr}${client ? ` (${client})` : ""}`);
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "devctl", version: VERSION },
        };
      }
      case "notifications/initialized":
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: enabledTools(this.disabled()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        return {
          resources: MCP_RESOURCE_URIS.map((uri) => ({
            uri,
            name: uri.replace("devctl://", ""),
            mimeType: "application/json",
          })),
        };
      case "resources/read":
        return this.readResource(params);
      default:
        throw new McpRpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = typeof params.name === "string" ? params.name : "";
    if (name === "") {
      throw new McpRpcError(INVALID_PARAMS, "tool name is required");
    }
    // Filtering tools/list is only discovery: an agent holding a tool list
    // from before the tool was disabled will still call it. Refuse here too,
    // and say *why* — "unknown tool" would send it hunting for a typo.
    if (isKnownToolName(name) && !toolEnabled(name, this.disabled())) {
      const message = `tool ${name} is disabled in devctl's MCP settings`;
      this.emit("WARN", `tool call rejected name=${name}: disabled`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const started = Date.now();
    try {
      const result = await callMcpTool(this.opts.hostApi, name, args);
      this.emit("INFO", `tool call name=${name} duration=${Date.now() - started}ms`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool failed";
      this.emit("WARN", `tool call failed name=${name} duration=${Date.now() - started}ms: ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = typeof params.uri === "string" ? params.uri : "";
    if (!isMcpResourceUri(uri)) {
      throw new McpRpcError(INVALID_PARAMS, `unknown resource ${uri}`);
    }
    const result = await readMcpResource(this.opts.hostApi, uri);
    this.emit("INFO", `resource read uri=${uri}`);
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
    };
  }
}

function extractClientInfo(params: Record<string, unknown>): string {
  const info = params.clientInfo;
  if (!isRecord(info)) {
    return "";
  }
  const name = typeof info.name === "string" ? info.name : "";
  const version = typeof info.version === "string" ? info.version : "";
  if (name === "") {
    return "";
  }
  return version === "" ? name : `${name} ${version}`;
}

function remoteAddr(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

class McpRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

function rpcError(id: JsonRpcId, code: number, message: string): unknown {
  return { jsonrpc: JSON_RPC, id, error: { code, message } };
}

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
