import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { formatHostPort, hostnameFromHostHeader, isLoopbackBindHost, isLoopbackHostname, isLoopbackPeer } from "../../domain/net/hosts.ts";
import type { UpdateCheck } from "../../domain/update.ts";
import { VERSION } from "../../version.ts";
import { bearerMatches } from "../../shared/bearer.ts";
import { KindGeneral, newError, wrapError } from "../../shared/errors.ts";
import { withErrorCode } from "../../domain/net/error-code.ts";
import { headerValue } from "../../shared/headers.ts";
import { LOCALHOST } from "../../domain/config/types.ts";
import type { McpHost } from "../../ports/mcp-host.ts";
import {
  callMcpTool,
  getConfigSummary,
  getLogs,
  getLogStats,
  getLogSession,
  getLlmCallTool,
  getLlmCalls,
  getTrafficCallTool,
  getTrafficCalls,
  getRequests,
  getStatusSummary,
  getTraceTool,
  isWebControlTool,
  iterateLogsExport,
  listLogSessions,
  listProfiles,
  listServices,
  traceRequestTool,
} from "../mcp/tools.ts";
import { WEB_INDEX_HTML } from "./assets.generated.ts";

const JSON_CONTENT = "application/json";
const JSONL_CONTENT = "application/x-ndjson; charset=utf-8";
const HTML_CONTENT = "text/html; charset=utf-8";
const NOSNIFF = { "X-Content-Type-Options": "nosniff" } as const;
const LOG_EXPORT_FILENAME = "devctl-logs.jsonl";
const FRAME_GUARD = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
} as const;
const HTML_BLOB = /export const WEB_INDEX_HTML = ("(?:\\.|[^"\\])*")/;
const ALLOW_GET = "GET";
const ALLOW_GET_POST = "GET, POST";
const ALLOW_POST = "POST";
const MAX_JSON_BODY_BYTES = 64 * 1024;

export type WebListenOptions = {
  host: string;
  port: number;
  token: string;
  hostApi: McpHost;
  checkUpdate?: () => Promise<UpdateCheck>;
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
    if (this.opts.token.trim() === "") {
      return Promise.reject(newError(KindGeneral, "web UI control token is required"));
    }
    const host = this.opts.host || LOCALHOST;
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(newError(KindGeneral, `refusing to bind web UI to ${host}`));
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.serve(req, res);
      });
      this.server.on("error", (err) => reject(wrapError(KindGeneral, withErrorCode(`unable to listen on ${host}:${this.opts.port}`, err), err)));
      this.server.listen(this.opts.port, host, () => {
        const addr = this.server?.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.addr = formatHostPort(host, this.boundPort);
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
    if (!hostAllowed(req.headers.host)) {
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      writeMethodNotAllowed(res, ALLOW_GET_POST);
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort}`);
    const path = url.pathname;
    try {
      if (method === "POST") {
        await this.routePost(path, req, res);
        return;
      }
      await this.routeGet(path, url.searchParams, req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      const status = err instanceof HttpError ? err.status : 400;
      this.opts.onEvent?.("WARN", `web ${path}: ${message}`);
      writeJson(res, status, { error: message });
    }
  }

  private async routeGet(path: string, query: URLSearchParams, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = this.opts.hostApi;
    if (path === "/") {
      writeHtml(res, pageHtml());
      return;
    }
    if (path === "/api/control") {
      writeMethodNotAllowed(res, ALLOW_POST);
      return;
    }
    // Every data-returning /api/* read requires the session bearer and a
    // loopback peer, matching POST /api/control and the MCP/token endpoints.
    // Only the HTML shell at "/" is anonymous; logs, config, traces, and LLM
    // bodies are not. Non-/api paths fall through to 404 without a token check.
    if (path.startsWith("/api/")) {
      assertLoopbackPeer(req);
      assertControlAuthorized(req, this.opts.token);
    }
    if (path === "/api/status") {
      writeJson(res, 200, getStatusSummary(host.status()));
      return;
    }
    if (path === "/api/update") {
      const result = this.opts.checkUpdate
        ? await this.opts.checkUpdate()
        : { current: VERSION, latest: "", newer: false, hint: "", kind: "unknown" as const };
      writeJson(res, 200, result);
      return;
    }
    if (path === "/api/services") {
      writeJson(res, 200, listServices(host.status(), host.config()));
      return;
    }
    if (path === "/api/requests") {
      writeJson(res, 200, await getRequests(host));
      return;
    }
    if (path === "/api/config") {
      writeJson(res, 200, getConfigSummary(host.config()));
      return;
    }
    if (path === "/api/preferences") {
      if (!host.getPreferences) {
        throw new HttpError(400, "preferences are unavailable");
      }
      const scope = query.get("scope") ?? "repo";
      writeJson(res, 200, host.getPreferences(scope === "user" ? "user" : "repo"));
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
    if (path === "/api/logs/stats") {
      writeJson(res, 200, await getLogStats(host, queryArgs(query)));
      return;
    }
    if (path === "/api/logs/export") {
      await streamLogsExport(host, queryArgs(query), res);
      return;
    }
    if (path === "/api/logs/sessions") {
      writeJson(res, 200, { sessions: await listLogSessions(host) });
      return;
    }
    const sessionId = matchParam(path, "/api/logs/sessions/");
    if (sessionId !== undefined) {
      const id = decodeURIComponent(sessionId);
      const sessions = await host.listLogSessions();
      if (!sessions.includes(id)) {
        throw new HttpError(404, "not found");
      }
      writeJson(res, 200, await getLogSession(host, id, queryArgs(query)));
      return;
    }
    if (path === "/api/doctor") {
      writeJson(res, 200, await host.doctor());
      return;
    }
    if (path === "/api/llm") {
      writeJson(res, 200, await getLlmCalls(host, queryArgs(query)));
      return;
    }
    const llmId = matchParam(path, "/api/llm/");
    if (llmId !== undefined) {
      writeJson(res, 200, await getLlmCallTool(host, { id: decodeURIComponent(llmId) }));
      return;
    }
    if (path === "/api/traffic") {
      writeJson(res, 200, await getTrafficCalls(host, queryArgs(query)));
      return;
    }
    const trafficId = matchParam(path, "/api/traffic/");
    if (trafficId !== undefined) {
      writeJson(res, 200, await getTrafficCallTool(host, { id: decodeURIComponent(trafficId) }));
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

  private async routePost(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (path !== "/api/control") {
      writeMethodNotAllowed(res, path === "/" || path.startsWith("/api/") ? ALLOW_GET : ALLOW_GET_POST);
      return;
    }
    assertControlAuthorized(req, this.opts.token);
    assertSameOriginControl(req);
    assertJsonContentType(req.headers["content-type"]);
    const body = await readJsonBody(req);
    const tool = typeof body.tool === "string" ? body.tool : "";
    if (!isWebControlTool(tool)) {
      throw new HttpError(400, "unknown or non-mutating tool");
    }
    const result = await callMcpTool(this.opts.hostApi, tool, objectArgs(body.args));
    writeJson(res, 200, result ?? { ok: true });
  }
}

function hostAllowed(header: string | string[] | undefined): boolean {
  const hostname = hostnameFromHostHeader(headerValue(header));
  return hostname !== undefined && isLoopbackHostname(hostname);
}

function originIsLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function assertControlAuthorized(req: IncomingMessage, token: string): void {
  if (!bearerMatches(headerValue(req.headers.authorization), token)) {
    throw new HttpError(401, "unauthorized");
  }
}

function assertLoopbackPeer(req: IncomingMessage): void {
  if (!isLoopbackPeer(req.socket.remoteAddress)) {
    throw new HttpError(403, "forbidden");
  }
}

function assertSameOriginControl(req: IncomingMessage): void {
  const origin = headerValue(req.headers.origin);
  if (origin !== "") {
    if (!originIsLoopback(origin)) {
      throw new HttpError(403, "cross-origin request rejected");
    }
    return;
  }
  const referer = headerValue(req.headers.referer);
  if (referer !== "" && originIsLoopback(referer)) {
    return;
  }
  throw new HttpError(403, "cross-origin request rejected");
}

function assertJsonContentType(header: string | string[] | undefined): void {
  const media = headerValue(header).split(";")[0]?.trim().toLowerCase() ?? "";
  if (media !== JSON_CONTENT) {
    throw new HttpError(415, "JSON content type required");
  }
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

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "args must be an object");
  }
  return value as Record<string, unknown>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        fail(new HttpError(413, "payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, "JSON object required"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

function writeMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { Allow: allow, ...NOSNIFF });
  res.end();
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

async function streamLogsExport(host: McpHost, args: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const lines = iterateLogsExport(host, args);
  const first = await lines.next();
  res.writeHead(200, {
    "Content-Type": JSONL_CONTENT,
    "Content-Disposition": `attachment; filename="${LOG_EXPORT_FILENAME}"`,
    "Cache-Control": "no-store",
    ...NOSNIFF,
  });
  if (!first.done && first.value !== undefined) {
    await writeResponseChunk(res, `${first.value}\n`);
  }
  for await (const line of lines) {
    await writeResponseChunk(res, `${line}\n`);
  }
  res.end();
}

function writeResponseChunk(res: ServerResponse, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    res.write(chunk, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function writeHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": HTML_CONTENT,
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    ...NOSNIFF,
    ...FRAME_GUARD,
  });
  res.end(html);
}

// Prefer the on-disk blob when running from source so `bun run build:web`
// is enough to refresh the UI. Compiled binaries have no sibling .ts file.
function pageHtml(): string {
  let source = "";
  try {
    source = readFileSync(join(import.meta.dir, "assets.generated.ts"), "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return WEB_INDEX_HTML;
    }
    throw err;
  }
  const match = HTML_BLOB.exec(source);
  if (!match?.[1]) {
    return WEB_INDEX_HTML;
  }
  try {
    return JSON.parse(match[1]) as string;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return WEB_INDEX_HTML;
    }
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
