import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { isLoopbackBindHost } from "../../domain/net/hosts.ts";
import { withErrorCode } from "../../domain/net/error-code.ts";
import { mapOtlpLogs, mapOtlpTraces } from "../../domain/telemetry/otlp.ts";
import { decodeOtlpLogsProto, decodeOtlpTracesProto } from "../../domain/telemetry/otlp-proto.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import { KindGeneral, newError, wrapError } from "../../shared/errors.ts";
import { LOCALHOST } from "../../domain/config/types.ts";

const JSON_CONTENT = "application/json";
const PROTOBUF_CONTENT = "application/x-protobuf";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const UNSUPPORTED_TYPE = `unsupported content type; send ${JSON_CONTENT} or ${PROTOBUF_CONTENT}`;

type Encoding = "json" | "protobuf";

export type OtlpHttpServerOpts = {
  host: string;
  port: number;
  logs: LogStore;
  spans: SpanStore;
  fallbackService?: string;
};

export class OtlpHttpServer {
  private server?: Server;
  private running = false;
  private addr = "";
  private readonly opts: OtlpHttpServerOpts;

  constructor(opts: OtlpHttpServerOpts) {
    this.opts = opts;
  }

  isRunning(): boolean {
    return this.running;
  }

  address(): string {
    return this.addr;
  }

  listenPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.opts.port;
  }

  endpoint(): string {
    const host = this.opts.host || LOCALHOST;
    return `http://${host}:${this.listenPort()}`;
  }

  start(): Promise<void> {
    const host = this.opts.host || LOCALHOST;
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(newError(KindGeneral, "OTLP receiver must bind to a loopback address"));
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server.on("error", (err) => reject(wrapError(KindGeneral, withErrorCode(`unable to listen on ${host}:${this.opts.port}`, err), err)));
      this.server.listen(this.opts.port, host, () => {
        const addr = this.server?.address();
        const port = addr && typeof addr === "object" ? addr.port : this.opts.port;
        this.addr = `${host}:${port}`;
        this.running = true;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.running = false;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (path !== "/v1/logs" && path !== "/v1/traces") {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    const encoding = bodyEncoding(req.headers["content-type"]);
    if (encoding === undefined) {
      writeJson(res, 415, { error: UNSUPPORTED_TYPE });
      return;
    }
    const contentEncoding = (req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
    if (contentEncoding !== "identity" && contentEncoding !== "gzip") {
      writeJson(res, 415, { error: `unsupported content encoding ${contentEncoding}; send gzip or identity` });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req);
      if (contentEncoding === "gzip") {
        bytes = gunzipSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
      }
    } catch (err) {
      // readBody's own limit, or gunzip's maxOutputLength (ERR_BUFFER_TOO_LARGE).
      const tooLarge = err instanceof Error && (err.message === "payload too large" || (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE");
      writeJson(res, tooLarge ? 413 : 400, { error: tooLarge ? "payload too large" : "invalid gzip body" });
      return;
    }
    let body: unknown;
    try {
      body = decodeBody(bytes, encoding, path);
    } catch {
      writeJson(res, 400, { error: encoding === "json" ? "invalid json" : "invalid protobuf" });
      return;
    }
    const service = this.opts.fallbackService ?? "otlp";
    if (path === "/v1/logs") {
      for (const record of mapOtlpLogs(body, service)) {
        this.opts.logs.append(record);
      }
    } else {
      for (const span of mapOtlpTraces(body, service)) {
        this.opts.spans.append(span);
      }
    }
    writeSuccess(res, encoding);
  }
}

// A missing Content-Type is read as JSON, as before protobuf support.
function bodyEncoding(header: string | undefined): Encoding | undefined {
  const type = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "" || type === JSON_CONTENT) {
    return "json";
  }
  if (type === PROTOBUF_CONTENT) {
    return "protobuf";
  }
  return undefined;
}

function decodeBody(bytes: Buffer, encoding: Encoding, path: string): unknown {
  if (encoding === "json") {
    return JSON.parse(bytes.toString("utf8"));
  }
  return path === "/v1/logs" ? decodeOtlpLogsProto(bytes) : decodeOtlpTracesProto(bytes);
}

// OTLP/HTTP answers in the request's encoding. An empty Export*ServiceResponse
// (no partial_success) is zero protobuf bytes.
function writeSuccess(res: ServerResponse, encoding: Encoding): void {
  if (encoding === "json") {
    writeJson(res, 200, { partialSuccess: {} });
    return;
  }
  res.writeHead(200, { "content-type": PROTOBUF_CONTENT, "content-length": 0 });
  res.end();
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": JSON_CONTENT, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
