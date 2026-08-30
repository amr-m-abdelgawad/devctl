import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { KindGeneral, newError, wrapError } from "../errors.ts";
import { VERSION } from "../version.ts";
import {
  callMcpTool,
  isMcpResourceUri,
  MCP_RESOURCE_URIS,
  MCP_TOOLS,
  readMcpResource,
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

export type McpListenOptions = {
  host: string;
  port: number;
  token: string;
  hostApi: McpHost;
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
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
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
    if (Array.isArray(parsed)) {
      const replies = [];
      for (const item of parsed) {
        const reply = await this.dispatch(item);
        if (reply !== undefined) {
          replies.push(reply);
        }
      }
      json(res, 200, replies);
      return;
    }
    const reply = await this.dispatch(parsed);
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

  private async dispatch(raw: unknown): Promise<unknown | undefined> {
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
      const result = await this.handleMethod(msg.method, isRecord(msg.params) ? msg.params : {});
      if (notification) {
        return undefined;
      }
      return { jsonrpc: JSON_RPC, id, result };
    } catch (err) {
      if (notification) {
        return undefined;
      }
      const code = err instanceof McpRpcError ? err.code : INTERNAL_ERROR;
      return rpcError(id, code, err instanceof Error ? err.message : "internal error");
    }
  }

  private async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "devctl", version: VERSION },
        };
      case "notifications/initialized":
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: MCP_TOOLS.map((tool) => ({
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
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      const result = await callMcpTool(this.opts.hostApi, name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool failed";
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = typeof params.uri === "string" ? params.uri : "";
    if (!isMcpResourceUri(uri)) {
      throw new McpRpcError(INVALID_PARAMS, `unknown resource ${uri}`);
    }
    const result = await readMcpResource(this.opts.hostApi, uri);
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
    };
  }
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
