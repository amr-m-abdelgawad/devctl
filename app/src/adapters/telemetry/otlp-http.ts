import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isLoopbackBindHost } from "../../domain/net/hosts.ts";
import { mapOtlpLogs, mapOtlpTraces } from "../../domain/telemetry/otlp.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import { KindGeneral, newError, wrapError } from "../../shared/errors.ts";
import { LOCALHOST } from "../../domain/config/types.ts";

const JSON_CONTENT = "application/json";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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
      this.server.on("error", (err) => reject(wrapError(KindGeneral, `unable to listen on ${host}:${this.opts.port}`, err)));
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
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: "invalid json" });
      return;
    }
    const service = this.opts.fallbackService ?? "otlp";
    if (path === "/v1/logs") {
      for (const record of mapOtlpLogs(body, service)) {
        this.opts.logs.append(record);
      }
      writeJson(res, 200, { partialSuccess: {} });
      return;
    }
    if (path === "/v1/traces") {
      for (const span of mapOtlpTraces(body, service)) {
        this.opts.spans.append(span);
      }
      writeJson(res, 200, { partialSuccess: {} });
      return;
    }
    writeJson(res, 404, { error: "not found" });
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": JSON_CONTENT, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
