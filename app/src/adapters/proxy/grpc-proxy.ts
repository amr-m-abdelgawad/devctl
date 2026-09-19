import * as http2 from "node:http2";
import type { Http2Server, ServerHttp2Stream, ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http2";
import type { RouteConfig } from "../config/index.ts";
import { listenKey, sameListen } from "../../domain/proxy/listen.ts";
import { isLoopbackBindHost } from "../../domain/net/hosts.ts";
import { matchGrpcOk } from "../../domain/proxy/grpc-ok.ts";
import { KindProxy, newError, wrapError } from "../../shared/errors.ts";
import { Bus, newEvent, ProxyRequest } from "../../shared/events.ts";
import { fromRoute, tokenIdentityKey } from "../../domain/identity/identity.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import { type Detector } from "../secrets/detector.ts";
import { type TokenManager } from "../google/token.ts";
import { injectIdentityHeaders, REQUEST_ID_HEADER, RequestLog, type ProxyRequestRecord } from "./proxy.ts";
import { startRouteTimeout, timeoutMessage, type TimeoutKind } from "./route-timeout.ts";
import { applyTraceHeaders, beginProxyTrace, proxyRecordToSpan, TRACEPARENT_HEADER } from "./tracing.ts";
import type { TrafficCaptureRecorder, TrafficCaptureSink } from "../../ports/traffic-capture.ts";

// gRPC status codes we synthesize when the request never reaches the upstream,
// or when the client abandons it.
const GRPC_UNAVAILABLE = "14";
const GRPC_UNAUTHENTICATED = "16";
const GRPC_CANCELLED = "1";
const GRPC_DEADLINE_EXCEEDED = "4";
// Request headers we never forward: HTTP/2-illegal connection headers, the
// hop's own host, and the client's Authorization (the proxy injects its own).
const DROP_REQUEST_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "authorization"]);

// A dedicated loopback HTTP/2 (h2c) listener that forwards every gRPC stream to
// one upstream over h2 (TLS when the upstream is https), injecting the route's
// auth token per RPC so a gRPC client — a Temporal worker, say — stays
// token-free. Auth reuses injectIdentityHeaders, the exact minting/refresh path
// the HTTP proxy uses, so `credentials` / `audience` / `auth.headers` all apply.
export class GrpcProxyServer {
  private server?: Http2Server;
  private readonly clients = new Map<string, ClientHttp2Session>();
  private running = false;
  private addr = "";
  private readonly requests = new RequestLog();

  constructor(
    private route: RouteConfig,
    private readonly tokens?: TokenManager,
    private readonly logs?: Pick<LogStore, "append">,
    private readonly bus?: Bus,
    private readonly detector?: Detector,
    private readonly spans?: SpanStore,
    private readonly traffic?: TrafficCaptureSink,
  ) {}

  address(): string {
    return this.addr;
  }

  isRunning(): boolean {
    return this.running;
  }

  stats(): ReturnType<RequestLog["stats"]> {
    return this.requests.stats();
  }

  routeName(): string {
    return this.route.name;
  }

  listenKey(): string {
    return listenKey(this.route.listen);
  }

  sameListen(route: RouteConfig): boolean {
    return sameListen(this.route.listen, route.listen);
  }

  // Swap auth/upstream/inspect/log on the live h2c listener. In-flight
  // streams already captured their route; new streams read this.route.
  // An upstream URL change retires the pooled client (GOAWAY) so the next
  // RPC dials the new target without closing this.server.
  replaceRoute(route: RouteConfig): void {
    const prevUrl = this.route.upstream.url;
    this.route = route;
    if (route.upstream.url === prevUrl) {
      return;
    }
    const stale = this.clients.get(prevUrl);
    this.clients.delete(prevUrl);
    stale?.close();
  }

  start(): Promise<void> {
    const host = this.route.listen?.host || "127.0.0.1";
    const port = this.route.listen?.port ?? 0;
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(newError(KindProxy, `refusing to bind grpc route ${this.route.name} to ${host}`));
    }
    if (port === 0) {
      return Promise.reject(newError(KindProxy, `grpc route ${this.route.name} requires listen.port`));
    }
    return new Promise((resolve, reject) => {
      const server = http2.createServer();
      server.on("stream", (stream, headers) => void this.serve(stream as ServerHttp2Stream, headers as IncomingHttpHeaders));
      // A session/stream error must never crash the daemon; per-stream errors
      // are handled in serve(), these guard the listener itself.
      server.on("sessionError", () => {});
      server.on("error", (err) => {
        if (this.running) {
          // A post-listen server error can't reject the settled start promise;
          // log it rather than dropping it silently.
          this.log("ERROR", `grpc route ${this.route.name} listener error: ${err.message}`);
          return;
        }
        reject(wrapError(KindProxy, `grpc route ${this.route.name} unable to listen on ${host}:${port}`, err));
      });
      server.listen(port, host, () => {
        this.server = server;
        this.running = true;
        this.addr = `${host}:${port}`;
        this.log("INFO", `grpc route ${this.route.name} listening on ${this.addr} → ${this.route.upstream.url}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    for (const session of this.clients.values()) {
      session.close();
    }
    this.clients.clear();
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => {
        this.running = false;
        resolve();
      });
    });
  }

  // One pooled HTTP/2 session per upstream URL. Recreated lazily after it
  // closes or a GOAWAY retires it. Keyed by URL so a mid-stream replaceRoute
  // cannot send a token-injected request to a different origin.
  private upstream(url = this.route.upstream.url): ClientHttp2Session {
    const existing = this.clients.get(url);
    if (existing && !existing.closed && !existing.destroyed) {
      return existing;
    }
    const session = http2.connect(url);
    const drop = (): void => {
      if (this.clients.get(url) === session) {
        this.clients.delete(url);
      }
    };
    session.on("error", drop);
    session.on("goaway", drop);
    session.on("close", drop);
    this.clients.set(url, session);
    return session;
  }

  private async serve(front: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<void> {
    const started = Date.now();
    const ctx = beginProxyTrace({
      traceparent: headerString(headers, TRACEPARENT_HEADER),
      requestId: headerString(headers, REQUEST_ID_HEADER),
    });
    const requestID = ctx.requestId;
    const method = String(headers[":path"] ?? "/"); // the gRPC method path
    // Capture at accept so a mid-stream replaceRoute cannot mix tables.
    const route = this.route;
    const ident = fromRoute(route.auth);
    const identityKey = tokenIdentityKey(ident);
    let recorded = false;
    let responded = false;
    let timeoutKind: TimeoutKind | undefined;
    let upReq: ReturnType<ClientHttp2Session["request"]> | undefined;
    let upTrailers: OutgoingHttpHeaders = {};
    const recorder = this.beginCapture(route.name, method, headers, front);
    const finish = (status: number, grpcStatus: string, error?: string): void => {
      if (recorded) return;
      recorded = true;
      timeouts.stop();
      if (timeoutKind) {
        error = error ?? timeoutMessage(timeoutKind);
      }
      const duration = Date.now() - started;
      const recordedPath = this.detector ? this.detector.redactText(method) : method;
      // A listed log.grpc.ok status is not a proxy error (Temporal long-poll
      // 14 / workflow-task 3). Unlisted non-zero statuses stay failures.
      const policy = error === undefined ? matchGrpcOk(route.log?.grpc?.ok, grpcStatus, method) : undefined;
      const treatedOk = grpcStatus === "0" || policy !== undefined;
      const failure = error ?? (treatedOk ? undefined : `grpc-status ${grpcStatus}`);
      const record: ProxyRequestRecord = {
        timestamp: new Date().toISOString(),
        requestId: requestID,
        method: "POST",
        path: recordedPath,
        route: route.name,
        identity: identityKey,
        status,
        durationMs: duration,
        error: failure,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: ctx.parentSpanId,
      };
      this.requests.record(record);
      this.spans?.append(proxyRecordToSpan(record));
      if (policy !== "silent") {
        this.log(failure ? "WARN" : "INFO", `grpc ${method} route=${route.name} identity=${identityKey} grpc-status=${grpcStatus} duration=${duration}ms${failure ? ` error=${failure}` : ""}`, requestID, identityKey);
      }
      this.bus?.publish(newEvent(ProxyRequest, route.name, { status, request_id: requestID, duration, identity: identityKey }));
      void this.finishCapture(recorder, status, grpcStatus, started, requestID, ctx.traceId);
    };
    const fail = (grpcStatus: string, message: string): void => {
      // Deliver the failure as a gRPC trailers-only response the client SDK
      // understands, rather than resetting the stream.
      try {
        front.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": grpcStatus, "grpc-message": message }, { endStream: true });
      } catch {
        front.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      }
      finish(200, grpcStatus, message);
    };
    const timeouts = startRouteTimeout(this.route.timeout, (kind) => {
      timeoutKind = kind;
      const message = timeoutMessage(kind);
      if (!responded) {
        fail(GRPC_DEADLINE_EXCEEDED, message);
      } else {
        upTrailers = { "grpc-status": GRPC_DEADLINE_EXCEEDED, "grpc-message": message };
        try {
          front.end();
        } catch {
          // already closed
        }
        finish(200, GRPC_DEADLINE_EXCEEDED, message);
      }
      try {
        upReq?.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        upReq?.destroy();
      }
    });

    let out: Record<string, string>;
    try {
      out = this.buildUpstreamHeaders(headers, route);
      applyTraceHeaders(out, ctx, REQUEST_ID_HEADER);
      await injectIdentityHeaders(route, out, this.tokens);
    } catch (err) {
      fail(GRPC_UNAUTHENTICATED, err instanceof Error ? err.message : "token injection failed");
      return;
    }

    try {
      if (timeoutKind || recorded) {
        return;
      }
      upReq = this.upstream(route.upstream.url).request(out as OutgoingHttpHeaders);
    } catch (err) {
      fail(GRPC_UNAVAILABLE, err instanceof Error ? err.message : "upstream unavailable");
      return;
    }

    upReq.on("response", (uh) => {
      if (responded) return;
      responded = true;
      // Trailers-only response (grpc-status already in the headers) — usually an
      // upstream error. Forward it verbatim and end; there is no body to pipe.
      if (uh["grpc-status"] !== undefined) {
        front.respond(this.frontResponseHeaders(uh), { endStream: true });
        finish(Number(uh[":status"] ?? 200), String(uh["grpc-status"]));
        return;
      }
      const contentType = headerString(uh, "content-type") ?? "application/grpc";
      recorder?.setResponseContentType(contentType);
      front.respond(this.frontResponseHeaders(uh), { waitForTrailers: true });
      front.on("wantTrailers", () => {
        try {
          front.sendTrailers(this.sanitizeTrailers(upTrailers));
        } catch {
          // stream already torn down
        }
        finish(Number(uh[":status"] ?? 200), String(upTrailers["grpc-status"] ?? "0"));
      });
      this.pipeWithCapture(upReq, front, recorder, "response", timeouts.touch);
      upReq.on("end", () => {
        try {
          front.end();
        } catch {
          // already closed
        }
      });
    });
    upReq.on("trailers", (t) => {
      upTrailers = t;
    });
    upReq.on("error", (err) => {
      if (recorded) {
        return;
      }
      if (!responded) {
        fail(GRPC_UNAVAILABLE, err.message);
      } else {
        finish(502, GRPC_UNAVAILABLE, err.message);
        front.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      }
    });
    front.on("error", () => upReq.destroy());
    // A client cancel (RST_STREAM) or disconnect surfaces as 'close', not
    // always 'error'. If the RPC never completed, record it as cancelled and
    // tear down the upstream stream so it cannot leak on the pooled session —
    // Temporal workers cancel long-poll RPCs constantly.
    front.on("close", () => {
      if (!recorded) {
        finish(499, GRPC_CANCELLED, "client closed before completion");
        upReq.destroy();
      }
    });
    this.pipeWithCapture(front, upReq, recorder, "request", timeouts.touch);
  }

  private beginCapture(
    routeName: string,
    path: string,
    headers: IncomingHttpHeaders,
    front: ServerHttp2Stream,
  ): TrafficCaptureRecorder | undefined {
    if (!this.traffic) {
      return undefined;
    }
    try {
      const requestHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
          continue;
        }
        requestHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      return this.traffic.begin({
        routeName,
        method: "POST",
        path,
        requestHeaders,
        transport: "grpc",
        peer: grpcCapturePeer(front),
      });
    } catch {
      return undefined;
    }
  }

  private async finishCapture(
    recorder: TrafficCaptureRecorder | undefined,
    status: number,
    grpcStatus: string,
    started: number,
    requestID: string,
    traceId?: string,
  ): Promise<void> {
    if (!recorder) {
      return;
    }
    try {
      await recorder.finish({
        status,
        grpcStatus,
        durationMs: Date.now() - started,
        requestId: requestID,
        traceId,
        timestamp: new Date(started).toISOString(),
      });
    } catch {
      // capture is best-effort; never let it disturb the proxied stream
    }
  }

  private pipeWithCapture(
    src: NodeJS.ReadableStream,
    dest: NodeJS.WritableStream,
    recorder: TrafficCaptureRecorder | undefined,
    side: "request" | "response",
    onActivity?: () => void,
  ): void {
    dest.on("drain", () => {
      if (!writableDestroyed(dest) && typeof src.resume === "function") {
        src.resume();
      }
    });
    src.on("data", (chunk: Buffer | string) => {
      onActivity?.();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (recorder) {
        try {
          if (side === "request") {
            recorder.appendRequest(buf);
          } else {
            recorder.appendResponse(buf);
          }
        } catch {
          // best-effort
        }
      }
      writeWithBackpressure(src, dest, buf);
    });
    if (side === "request") {
      src.on("end", () => {
        if (!writableDestroyed(dest)) {
          dest.end();
        }
      });
    }
  }

  // Copy client request headers minus pseudo-headers, HTTP/2-illegal connection
  // headers, and the client's own Authorization; then re-point the pseudo
  // headers at the upstream. injectIdentityHeaders adds Authorization + any
  // configured auth.headers afterward.
  private buildUpstreamHeaders(inHeaders: IncomingHttpHeaders, route: RouteConfig = this.route): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(inHeaders)) {
      if (key.startsWith(":") || DROP_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) {
        continue;
      }
      out[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    const target = new URL(route.upstream.url);
    out[":method"] = String(inHeaders[":method"] ?? "POST");
    out[":path"] = String(inHeaders[":path"] ?? "/");
    out[":scheme"] = target.protocol === "https:" ? "https" : "http";
    out[":authority"] = target.host;
    return out;
  }

  private frontResponseHeaders(uh: IncomingHttpHeaders): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = { ":status": uh[":status"] ?? 200 };
    for (const [key, value] of Object.entries(uh)) {
      if (key.startsWith(":") || DROP_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) {
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  private sanitizeTrailers(trailers: OutgoingHttpHeaders): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(trailers)) {
      if (key.startsWith(":") || value === undefined) {
        continue;
      }
      out[key] = value;
    }
    if (out["grpc-status"] === undefined) {
      out["grpc-status"] = "0";
    }
    return out;
  }

  private log(level: "INFO" | "WARN" | "ERROR", message: string, requestID = "", identity = ""): void {
    this.logs?.append({ timestamp: new Date().toISOString(), service: "proxy", source: "proxy", level, message, pid: 0, request_id: requestID, identity });
  }
}

function writableDestroyed(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as NodeJS.WritableStream & { destroyed?: boolean }).destroyed);
}

export function writeWithBackpressure(src: NodeJS.ReadableStream, dest: NodeJS.WritableStream, chunk: Buffer): void {
  if (writableDestroyed(dest)) {
    src.pause();
    return;
  }
  try {
    if (!dest.write(chunk)) {
      src.pause();
    }
  } catch {
    src.pause();
  }
}

function grpcCapturePeer(stream: ServerHttp2Stream): { address: string; port: number } | undefined {
  const socket = stream.session?.socket;
  const port = socket?.remotePort;
  if (!Number.isInteger(port) || port === undefined || port <= 0) {
    return undefined;
  }
  return { address: socket?.remoteAddress ?? "", port };
}

function headerString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0] !== "") {
    return value[0];
  }
  return undefined;
}
