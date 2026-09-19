import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { type Duplex, PassThrough, Readable } from "node:stream";
import { type ProxyConfig, type RouteConfig, isGrpcRoute, listenAddress } from "../config/index.ts";
import { stripMatchPrefix } from "../../domain/proxy/strip-prefix.ts";
import { isLoopbackBindHost, isLoopbackPeer } from "../../domain/net/hosts.ts";
import { KindProxy, newError, wrapError } from "../../shared/errors.ts";
import { Bus, newEvent, ProxyRequest, ProxyStarted, ProxyStopped } from "../../shared/events.ts";
import { fromRoute, tokenIdentityKey, tokenMintAllowed, type TokenMint } from "../../domain/identity/identity.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import { formatTraceparent } from "../../domain/logs/ids.ts";
import { applyTraceHeaders, beginProxyTrace, proxyRecordToSpan, TRACEPARENT_HEADER } from "./tracing.ts";
import { type Detector } from "../secrets/detector.ts";
import { applyExtraAuthHeaders, mintAuthToken } from "../http/identity.ts";
import { type TokenManager, isTokenMintRateLimited, TOKEN_MINT_WINDOW_MS } from "../google/token.ts";
import type { HttpRecipeRuntime } from "../../ports/http-recipe-runtime.ts";
import type { LlmCaptureRecorder, LlmCaptureSink } from "../../ports/llm-capture.ts";
import type { TrafficCaptureRecorder, TrafficCaptureSink } from "../../ports/traffic-capture.ts";
import { isLlmCallerHeader } from "../../domain/llm/caller.ts";
import { startRouteTimeout, timeoutMessage, type TimeoutKind } from "./route-timeout.ts";
import { timeoutMs } from "../../domain/proxy/timeout.ts";

export const REQUEST_ID_HEADER = "x-devctl-request-id";
export const INTERNAL_TOKEN_HEADER = "x-devctl-internal-token";
const RECENT_REQUESTS_CAP = 100;

export type ProxyRequestRecord = {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  route: string;
  identity: string;
  status: number;
  durationMs: number;
  error?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
};

// Newest-last bounded ring of recent proxy requests. `total` / `errors` are
// lifetime counts so they keep growing after the ring fills; `recent` is the
// capped window used by the TUI and web request tables.
export class RequestLog {
  private readonly items: ProxyRequestRecord[] = [];
  private recorded = 0;
  private errorCount = 0;
  constructor(private readonly cap: number = RECENT_REQUESTS_CAP) {}
  record(item: ProxyRequestRecord): void {
    this.recorded += 1;
    if (item.status >= 400 || item.error) {
      this.errorCount += 1;
    }
    this.items.push(item);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }
  stats(): { total: number; errors: number; recent: ProxyRequestRecord[] } {
    return { total: this.recorded, errors: this.errorCount, recent: [...this.items].reverse() };
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// What we always tell upstream we accept — fetch() transparently decompresses
// a response in any of these, so it's also the exact set we can safely
// assume was decompressed when deciding whether to strip content-encoding /
// content-length below.
const NEGOTIATED_ENCODINGS = new Set(["gzip", "deflate", "br"]);

export type ProxyMiddleware = {
  name: string;
  apply: (ctx: ProxyMiddlewareContext) => Promise<void>;
};

export type ProxyMiddlewareContext = {
  route: RouteConfig;
  headers: Record<string, string>;
  tokens?: TokenManager;
  req?: IncomingMessage;
  method?: string;
  path?: string;
  upgrade?: boolean;
};

export class ProxyServer {
  private cfg: ProxyConfig;
  private readonly tokens?: TokenManager;
  private readonly logs?: Pick<LogStore, "append">;
  private readonly spans?: SpanStore;
  private readonly bus?: Bus;
  private readonly detector?: Detector;
  // Resolves a service-reference upstream (route.upstream.service) to its
  // current loopback port at request time. Injected by the daemon from its
  // live assigned-ports map, so a synthesized `expose`/`gateway` route follows
  // a service that restarts on a new auto-assigned port without a proxy reload.
  private readonly resolvePort?: (service: string, port: string) => number | undefined;
  private readonly recipes?: HttpRecipeRuntime;
  // Optional LLM body-capture sink. Absent for all normal proxies; when present
  // it captures completion bodies only on routes a proxy LLM source tags, and
  // returns undefined for everything else so untagged traffic is untouched.
  private readonly capture?: LlmCaptureSink;
  // Optional traffic inspector sink. Per-route inspect.enabled; best-effort.
  private readonly traffic?: TrafficCaptureSink;
  private middleware: ProxyMiddleware[];
  private server?: Server;
  private running = false;
  private addr = "";
  private readonly upgradedSockets = new Set<Duplex>();
  private readonly requests = new RequestLog();

  constructor(
    cfg: ProxyConfig,
    tokens?: TokenManager,
    logs?: Pick<LogStore, "append">,
    bus?: Bus,
    detector?: Detector,
    middleware: ProxyMiddleware[] = [],
    resolvePort?: (service: string, port: string) => number | undefined,
    spans?: SpanStore,
    recipes?: HttpRecipeRuntime,
    capture?: LlmCaptureSink,
    traffic?: TrafficCaptureSink,
  ) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.logs = logs;
    this.bus = bus;
    this.detector = detector;
    this.middleware = middleware;
    this.resolvePort = resolvePort;
    this.spans = spans;
    this.recipes = recipes;
    this.capture = capture;
    this.traffic = traffic;
  }

  // The effective upstream base URL for a route. A hand-written route uses its
  // literal url; a synthesized route names a service + port, resolved to the
  // service's current loopback port here (throws when the service isn't
  // running, surfacing as a 502 through the request handlers' catch blocks).
  private upstreamBase(route: RouteConfig): string {
    const service = route.upstream.service ?? "";
    if (service === "") {
      return route.upstream.url;
    }
    if (!this.resolvePort) {
      throw newError(KindProxy, `route ${route.name} addresses service ${service} but this proxy has no port resolver configured`);
    }
    const port = this.resolvePort(service, route.upstream.port ?? "");
    if (port === undefined) {
      throw newError(KindProxy, `upstream service ${service} is not running`);
    }
    return `http://127.0.0.1:${port}`;
  }

  address(): string {
    return this.addr || listenAddress(this.cfg.listen);
  }

  listenBind(): { host: string; port: number } {
    // Prefer the address actually bound at start() so an in-place config
    // mutation cannot hide a listen change from applyConfig().
    if (this.addr !== "") {
      const colon = this.addr.lastIndexOf(":");
      return { host: this.addr.slice(0, colon), port: Number(this.addr.slice(colon + 1)) || 0 };
    }
    return {
      host: this.cfg.listen.host || "127.0.0.1",
      port: this.cfg.listen.port,
    };
  }

  setMiddleware(middleware: ProxyMiddleware[]): void {
    this.middleware = middleware;
  }

  // Swap the live route table / token_endpoint / credentials without closing
  // the HTTP listener. In-flight handlers already captured their matched
  // route; new requests read this.cfg at match time.
  replaceConfig(cfg: ProxyConfig): void {
    this.cfg = cfg;
  }

  isRunning(): boolean {
    return this.running;
  }

  stats(): { total: number; errors: number; recent: ProxyRequestRecord[] } {
    return this.requests.stats();
  }

  private recordRequest(record: ProxyRequestRecord): void {
    this.requests.record(record);
    if (this.spans && (record.traceId || record.requestId)) {
      this.spans.append(proxyRecordToSpan(record));
    }
  }

  // Configured response headers (e.g. CORS Access-Control-Allow-*), applied to
  // every response on the route and overriding whatever the upstream sent.
  private applyResponseHeaders(res: ServerResponse, route: RouteConfig): void {
    for (const [key, value] of Object.entries(route.response_headers ?? {})) {
      res.setHeader(key, value);
    }
  }

  start(): Promise<void> {
    const host = this.cfg.listen.host || "127.0.0.1";
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(newError(KindProxy, `refusing to bind proxy to ${host}`));
    }
    if (this.cfg.listen.port === 0) {
      return Promise.reject(newError(KindProxy, "proxy.listen.port is required when the proxy is enabled"));
    }
    const port = this.cfg.listen.port;
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.serve(req, res);
      });
      this.server.on("upgrade", (req, socket, head) => {
        void this.serveUpgrade(req, socket, head);
      });
      this.server.on("error", (err) => reject(wrapError(KindProxy, `unable to listen on ${host}:${port}`, err)));
      this.server.listen(port, host, () => {
        this.running = true;
        this.addr = `${host}:${port}`;
        this.bus?.publish(newEvent(ProxyStarted, "", { address: this.addr }));
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return Promise.resolve();
    }
    for (const socket of this.upgradedSockets) {
      socket.destroy();
    }
    this.upgradedSockets.clear();
    return new Promise((resolve) => {
      server.close(() => {
        this.running = false;
        this.bus?.publish(newEvent(ProxyStopped, "", {}));
        resolve();
      });
    });
  }

  private async serveUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const started = Date.now();
    const ctx = beginProxyTrace({
      traceparent: req.headers[TRACEPARENT_HEADER]?.toString(),
      requestId: req.headers[REQUEST_ID_HEADER]?.toString(),
    });
    const requestID = ctx.requestId;
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const recordedPath = this.detector ? this.detector.redactText(path) : path;
    const route = matchRoute(this.cfg.routes, req);
    if (!route) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      this.recordRequest({
        timestamp: new Date().toISOString(), requestId: requestID, method, path: recordedPath,
        route: "", identity: "", status: 404, durationMs: Date.now() - started,
        traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId,
      });
      return;
    }

    const ident = fromRoute(route.auth);
    const identityKey = tokenIdentityKey(ident);
    let upstreamSocket: Duplex | undefined;
    let upgradeReq: ReturnType<ReturnType<typeof proxyUpgradeRequest>> | undefined;
    let recorded = false;
    const finish = (status: number, error?: string): void => {
      if (recorded) return;
      recorded = true;
      if (status >= 400 || error) {
        timeouts.stop();
      }
      const duration = Date.now() - started;
      this.recordRequest({
        timestamp: new Date().toISOString(), requestId: requestID, method, path: recordedPath,
        route: route.name, identity: identityKey, status, durationMs: duration, error,
        traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId,
      });
      this.logs?.append({
        timestamp: new Date().toISOString(), service: "proxy", source: "proxy",
        level: status >= 400 || error ? "ERROR" : "INFO",
        message: `${method} ${path} route=${route.name} identity=${identityKey} status=${status} duration=${duration}ms upgrade=true${error ? ` error=${error}` : ""}`,
        pid: 0, request_id: requestID, identity: identityKey,
      });
      this.bus?.publish(newEvent(ProxyRequest, route.name, { status, request_id: requestID, duration, identity: identityKey }));
    };
    const closeBoth = (): void => {
      socket.destroy();
      upstreamSocket?.destroy();
      upgradeReq?.destroy();
    };
    // WebSocket: total_ms aborts/destroys both sockets. idle_ms also applies
    // and resets on each data chunk either direction (including the upgrade
    // handshake completing). Same policy as HTTP fetch/pipe.
    let timeoutKind: TimeoutKind | undefined;
    const timeouts = startRouteTimeout(route.timeout, (kind) => {
      timeoutKind = kind;
      const detail = timeoutMessage(kind);
      finish(504, detail);
      if (!upstreamSocket) {
        try {
          socket.end("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        } catch {
          socket.destroy();
        }
      }
      closeBoth();
    });
    socket.on("data", () => timeouts.touch());

    try {
      if ((route.upstream.recipe ?? "") !== "") {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        finish(502, "http recipe routes do not support protocol upgrade");
        return;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower) && lower !== "connection" && lower !== "upgrade") continue;
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(",");
      }
      const clientAddress = req.socket.remoteAddress ?? "";
      const originalHost = headers.host ?? "";
      const forwardedFor = headers["x-forwarded-for"];
      headers["x-forwarded-for"] = forwardedFor ? `${forwardedFor}, ${clientAddress}` : clientAddress;
      headers["x-forwarded-host"] = originalHost;
      headers["x-forwarded-proto"] = "http";
      delete headers.host;
      applyTraceHeaders(headers, ctx, REQUEST_ID_HEADER);
      if (this.middleware.length === 0) await injectIdentityHeaders(route, headers, this.tokens);
      for (const hook of this.middleware) {
        await hook.apply({ route, headers, tokens: this.tokens, req, method, path, upgrade: true });
      }

      const upstream = resolveProxyTarget(this.upstreamBase(route), forwardedRequestUrl(route, path));
      const upstreamReq = proxyUpgradeRequest(upstream)(upstream, { method, headers });
      upgradeReq = upstreamReq;
      upstreamReq.on("upgrade", (upstreamRes, connectedSocket, upstreamHead) => {
        upstreamSocket = connectedSocket;
        this.upgradedSockets.add(socket);
        this.upgradedSockets.add(connectedSocket);
        timeouts.touch();
        connectedSocket.on("data", () => timeouts.touch());
        const cleanup = (): void => {
          timeouts.stop();
          this.upgradedSockets.delete(socket);
          this.upgradedSockets.delete(connectedSocket);
        };
        socket.once("close", () => {
          cleanup();
          connectedSocket.destroy();
        });
        connectedSocket.once("close", () => {
          cleanup();
          socket.destroy();
        });
        socket.once("error", closeBoth);
        connectedSocket.once("error", closeBoth);
        const statusLine = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}\r\n`;
        const responseHeaders = upstreamRes.rawHeaders.map((value, index) => `${index % 2 === 0 ? value + ":" : " " + value + "\r\n"}`).join("");
        socket.write(`${statusLine}${responseHeaders}\r\n`);
        if (head.length > 0) connectedSocket.write(head);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        socket.pipe(connectedSocket).pipe(socket);
        finish(upstreamRes.statusCode ?? 101);
      });
      upstreamReq.on("response", (upstreamRes) => {
        timeouts.stop();
        upstreamRes.resume();
        const status = upstreamRes.statusCode ?? 502;
        socket.end(`HTTP/1.1 ${status} ${upstreamRes.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        finish(status, "upstream refused protocol upgrade");
      });
      upstreamReq.on("error", (err) => {
        if (timeoutKind) {
          return;
        }
        timeouts.stop();
        finish(502, err.message);
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      socket.once("error", () => upstreamReq.destroy());
      socket.once("close", () => {
        if (!upstreamSocket) {
          timeouts.stop();
        }
      });
      upstreamReq.end();
    } catch (err) {
      timeouts.stop();
      if (timeoutKind) {
        return;
      }
      const detail = err instanceof Error ? err.message : "proxy upgrade error";
      finish(502, detail);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const ctx = beginProxyTrace({
      traceparent: req.headers[TRACEPARENT_HEADER]?.toString(),
      requestId: req.headers[REQUEST_ID_HEADER]?.toString(),
    });
    const requestID = ctx.requestId;
    // Echo back so a caller can correlate its own request with the matching
    // row in stats().recent (and the "auth" log line) without having had to
    // supply the id itself.
    res.setHeader(REQUEST_ID_HEADER, requestID);
    res.setHeader(TRACEPARENT_HEADER, formatTraceparent(ctx));
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const recordedPath = this.detector ? this.detector.redactText(path) : path;
    const route = matchRoute(this.cfg.routes, req);
    if (!route) {
      writePlain(res, 404, "no matching proxy route");
      this.recordRequest({
        timestamp: new Date().toISOString(),
        requestId: requestID,
        method,
        path: recordedPath,
        route: "",
        identity: "",
        status: 404,
        durationMs: Date.now() - started,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: ctx.parentSpanId,
      });
      return;
    }
    // Answer a CORS preflight directly with the route's response headers: the
    // upstream may not handle OPTIONS, and IAP would reject an unauthenticated
    // preflight. Only a genuine preflight (Access-Control-Request-Method) on a
    // route that configures response_headers short-circuits; any other OPTIONS
    // is forwarded normally.
    if (method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined && (Object.keys(route.response_headers ?? {}).length > 0 || (route.upstream.recipe ?? "") !== "")) {
      this.applyResponseHeaders(res, route);
      res.statusCode = 204;
      res.setHeader("content-length", "0");
      res.end();
      this.recordRequest({ timestamp: new Date().toISOString(), requestId: requestID, method, path: recordedPath, route: route.name, identity: "", status: 204, durationMs: Date.now() - started, traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId });
      return;
    }
    if ((route.upstream.recipe ?? "") !== "") {
      await this.serveRecipe(route, res, method, recordedPath, requestID, started, ctx);
      return;
    }
    const ident = fromRoute(route.auth);
    const identityKey = tokenIdentityKey(ident);
    let status = 0;
    let errorDetail: string | undefined;
    // Declared outside the try so the finally can close the capture even when
    // the upstream errors or the client disconnects mid-response.
    let recorder: HttpCaptureTee | undefined;
    const abort = new AbortController();
    let timeoutKind: TimeoutKind | undefined;
    const timeouts = startRouteTimeout(route.timeout, (kind) => {
      timeoutKind = kind;
      if (!res.headersSent) {
        this.applyResponseHeaders(res, route);
        writePlain(res, 504, "gateway timeout");
      } else if (!res.writableEnded) {
        res.end();
      }
      abort.abort();
    });
    try {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) {
          continue;
        }
        if (typeof value === "string") {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.join(",");
        }
      }
      const clientAddress = req.socket.remoteAddress ?? "";
      const originalHost = headers.host ?? "";
      const forwardedFor = headers["x-forwarded-for"];
      headers["x-forwarded-for"] = forwardedFor ? `${forwardedFor}, ${clientAddress}` : clientAddress;
      headers["x-forwarded-host"] = originalHost;
      headers["x-forwarded-proto"] = "http";
      // Let fetch derive Host from the upstream URL instead of forwarding
      // the client's — otherwise the upstream sees the devctl-facing
      // hostname instead of its own.
      delete headers.host;
      // Pin exactly what we can safely undo below: fetch auto-decompresses
      // a response in any of these regardless of what the client asked for,
      // but still reports the *compressed* content-encoding/content-length
      // on the Response object — see the header-stripping logic after fetch.
      headers["accept-encoding"] = "gzip, deflate, br";
      applyTraceHeaders(headers, ctx, REQUEST_ID_HEADER);
      if (this.middleware.length === 0) {
        await injectIdentityHeaders(route, headers, this.tokens);
      }
      for (const hook of this.middleware) {
        await hook.apply({ route, headers, tokens: this.tokens });
      }
      const upstream = resolveProxyTarget(this.upstreamBase(route), forwardedRequestUrl(route, path));
      // Best-effort: undefined for untagged traffic, which keeps the original
      // streamed request body / non-teed response path byte-for-byte.
      // Snapshot headers: the forwarded map is mutated below (caller header
      // stripped, identity injected) and must not rewrite the captured request.
      recorder = this.beginCapture(route.name, method, path, headers, req);
      stripLlmCallerHeaders(headers);
      const prepared = await this.prepareRequestBody(req, method, recorder, timeoutMs(route.timeout?.idle_ms) ? timeouts.touch : undefined);
      const resp = await fetchOrAbort(upstream, {
        method,
        headers,
        body: prepared.body,
        redirect: "manual",
        signal: abort.signal,
        // @ts-expect-error Bun/undici duplex for streamed request bodies
        duplex: prepared.duplex,
      }, () => new Error(timeoutMessage(timeoutKind ?? "total")));
      if (timeoutKind) {
        throw new Error(timeoutMessage(timeoutKind));
      }
      timeouts.touch();
      res.statusCode = resp.status;
      status = resp.status;
      // fetch() already decompressed the body if its content-encoding is
      // one of NEGOTIATED_ENCODINGS (see above) — but it leaves the
      // Response's own content-encoding/content-length headers describing
      // the original *compressed* bytes, not the decompressed body
      // pipeResponse is about to send. Forwarding those headers unchanged
      // would lie to the client. Strip them only when every encoding on the
      // response is one we know fetch decompressed; anything outside that
      // set was never touched, so its headers still describe exactly the
      // bytes being forwarded and must be preserved as-is.
      const responseEncodings = (resp.headers.get("content-encoding") ?? "")
        .split(",")
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token !== "");
      const decompressedByFetch = responseEncodings.length > 0 && responseEncodings.every((token) => NEGOTIATED_ENCODINGS.has(token));
      resp.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower)) {
          return;
        }
        if (decompressedByFetch && (lower === "content-encoding" || lower === "content-length")) {
          return;
        }
        res.setHeader(key, this.detector ? this.detector.redactText(value) : value);
      });
      // Configured response headers win over whatever the upstream sent.
      this.applyResponseHeaders(res, route);
      // Record the upstream content-type regardless of whether we tee, so an
      // exotic-encoding row still says what came back.
      if (recorder) {
        recorder.setResponseContentType(resp.headers.get("content-type") ?? "");
      }
      // Tee the response into the capture recorder only when fetch left us
      // plaintext (no encoding, or one it already decompressed); otherwise the
      // bytes are still compressed and unparseable, so forward without copying.
      const teeable = responseEncodings.length === 0 || decompressedByFetch;
      if (recorder && teeable) {
        const rec = recorder;
        await pipeResponse(resp, res, (chunk) => rec.appendResponse(chunk), timeouts.touch);
      } else {
        await pipeResponse(resp, res, undefined, timeouts.touch);
      }
      if (timeoutKind) {
        throw new Error(timeoutMessage(timeoutKind));
      }
      const duration = Date.now() - started;
      this.logs?.append({
        timestamp: new Date().toISOString(),
        service: "proxy",
        source: "proxy",
        level: resp.status >= 400 ? "WARN" : "INFO",
        message: `${method} ${path} route=${route.name} identity=${identityKey} status=${resp.status} duration=${duration}ms`,
        pid: 0,
        request_id: requestID,
        identity: identityKey,
      });
      this.bus?.publish(newEvent(ProxyRequest, route.name, { status: resp.status, request_id: requestID, duration, identity: identityKey }));
    } catch (err) {
      if (timeoutKind) {
        const detail = timeoutMessage(timeoutKind);
        errorDetail = detail;
        status = 504;
        this.logProxyFailure(method, path, route.name, requestID, detail, "", identityKey);
        if (!res.headersSent) {
          this.applyResponseHeaders(res, route);
          writePlain(res, 504, "gateway timeout");
        }
      } else {
        const detail = err instanceof Error ? err.message : "proxy error";
        errorDetail = detail;
        status = 502;
        this.logProxyFailure(method, path, route.name, requestID, detail, "", identityKey);
        // Apply CORS/response headers to the error too, so the browser can read it.
        this.applyResponseHeaders(res, route);
        writePlain(res, 502, "proxy error");
      }
    } finally {
      timeouts.stop();
      this.recordProxyHit(method, recordedPath, route.name, requestID, started, status, identityKey, errorDetail, ctx);
      await this.finishCapture(recorder, status, started, requestID, ctx);
    }
  }

  private async serveRecipe(
    route: RouteConfig,
    res: ServerResponse,
    method: string,
    recordedPath: string,
    requestID: string,
    started: number,
    ctx: { traceId?: string; spanId?: string; parentSpanId?: string },
  ): Promise<void> {
    const recipeName = route.upstream.recipe ?? "";
    let status = 0;
    let errorDetail: string | undefined;
    try {
      if (!this.recipes) {
        throw newError(KindProxy, `route ${route.name} addresses http recipe ${recipeName} but this proxy has no recipe runtime`);
      }
      const snapshot = await this.recipes.ensure(recipeName);
      res.statusCode = snapshot.status;
      status = snapshot.status;
      if (snapshot.contentType !== "") {
        res.setHeader("content-type", snapshot.contentType);
      }
      this.applyResponseHeaders(res, route);
      res.end(snapshot.body);
      const duration = Date.now() - started;
      this.logs?.append({
        timestamp: new Date().toISOString(),
        service: "proxy",
        source: "proxy",
        level: snapshot.status >= 400 ? "WARN" : "INFO",
        message: `${method} ${recordedPath} route=${route.name} recipe=${recipeName} status=${snapshot.status} duration=${duration}ms`,
        pid: 0,
        request_id: requestID,
      });
      this.bus?.publish(newEvent(ProxyRequest, route.name, { status: snapshot.status, request_id: requestID, duration, identity: "" }));
    } catch (err) {
      errorDetail = err instanceof Error ? err.message : "proxy error";
      status = 502;
      this.logProxyFailure(method, recordedPath, route.name, requestID, errorDetail, ` recipe=${recipeName}`);
      this.applyResponseHeaders(res, route);
      writePlain(res, 502, "proxy error");
    } finally {
      this.recordProxyHit(method, recordedPath, route.name, requestID, started, status, "", errorDetail, ctx);
    }
  }

  private logProxyFailure(method: string, path: string, route: string, requestID: string, detail: string, extra = "", identity = ""): void {
    this.logs?.append({
      timestamp: new Date().toISOString(),
      service: "proxy",
      source: "proxy",
      level: "ERROR",
      message: `${method} ${path} route=${route}${identity ? ` identity=${identity}` : ""}${extra} error=${detail}`,
      pid: 0,
      request_id: requestID,
      identity,
    });
  }

  private recordProxyHit(
    method: string,
    path: string,
    route: string,
    requestID: string,
    started: number,
    status: number,
    identity: string,
    error: string | undefined,
    ctx: { traceId?: string; spanId?: string; parentSpanId?: string },
  ): void {
    this.recordRequest({
      timestamp: new Date().toISOString(),
      requestId: requestID,
      method,
      path,
      route,
      identity,
      status,
      durationMs: Date.now() - started,
      error,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: ctx.parentSpanId,
    });
  }

  private beginCapture(
    routeName: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    req: IncomingMessage,
  ): HttpCaptureTee | undefined {
    const peer = capturePeer(req);
    const tees: HttpCaptureTee[] = [];
    if (this.capture) {
      try {
        const recorder = this.capture.begin({
          routeName,
          method,
          path,
          requestHeaders: { ...headers },
          peer,
        });
        if (recorder) {
          tees.push(safeHttpTee(recorder));
        }
      } catch {
        // capture is best-effort
      }
    }
    if (this.traffic) {
      try {
        const recorder = this.traffic.begin({
          routeName,
          method,
          path,
          requestHeaders: { ...headers },
          transport: "http",
          peer,
        });
        if (recorder) {
          tees.push(safeHttpTee(recorder));
        }
      } catch {
        // capture is best-effort
      }
    }
    return combineHttpTees(tees);
  }

  // For a capture target with a known, in-cap content-length, buffer the request
  // fully and forward it as a Buffer — safer than teeing the Readable that undici
  // is consuming. Otherwise stream it unchanged and mark the stored body omitted.
  private async prepareRequestBody(
    req: IncomingMessage,
    method: string,
    recorder: HttpCaptureTee | undefined,
    onActivity?: () => void,
  ): Promise<{ body: BodyInit | undefined; duplex: "half" | undefined }> {
    if (method === "GET" || method === "HEAD") {
      return { body: undefined, duplex: undefined };
    }
    if (recorder) {
      const length = contentLengthOf(req);
      // A compressed request body would be stored as unparseable bytes, so skip
      // capturing it (the full body is still streamed to the upstream verbatim).
      if (!requestIsEncoded(req) && length !== undefined && length <= recorder.maxBytes) {
        // Pass the cap into the read as a read-time invariant so the memory
        // ceiling does not depend on this guard's condition staying correct.
        // (node:http already frames the body to Content-Length, so this backs
        // up the guard rather than closing a reachable overflow today.)
        const buffered = await readRequestBody(req, recorder.maxBytes, onActivity);
        recorder.setRequestBody(buffered);
        return { body: buffered as unknown as BodyInit, duplex: undefined };
      }
      recorder.setRequestBody(Buffer.alloc(0), { omitted: true });
    }
    if (onActivity) {
      return { body: tapRequestBody(req, onActivity) as unknown as BodyInit, duplex: "half" };
    }
    return { body: req as unknown as BodyInit, duplex: "half" };
  }

  private async finishCapture(
    recorder: HttpCaptureTee | undefined,
    status: number,
    started: number,
    requestID: string,
    ctx: { traceId?: string },
  ): Promise<void> {
    if (!recorder) {
      return;
    }
    try {
      await recorder.finish({
        status: status || 502,
        durationMs: Date.now() - started,
        requestId: requestID,
        traceId: ctx.traceId,
        timestamp: new Date(started).toISOString(),
      });
    } catch {
      // capture is best-effort; never let it disturb the proxied request
    }
  }

}

export async function injectIdentityHeaders(
  route: RouteConfig,
  headers: Record<string, string>,
  tokens?: TokenManager,
): Promise<void> {
  const token = await mintAuthToken(route.auth, tokens);
  if (!token) {
    return;
  }
  headers.authorization = `Bearer ${token}`;
  applyExtraAuthHeaders(headers, route.auth.headers, token);
}

// `onChunk` observes each response chunk for LLM capture while the body streams
// to the client unchanged. It returns false once the byte cap is hit so we stop
// copying (forwarding continues); a throw in it disables capture but never the
// pipe. The response is always streamed, never buffered-then-forwarded, so SSE
// keeps flowing.
async function pipeResponse(resp: Response, res: ServerResponse, onChunk?: (chunk: Buffer) => boolean, onActivity?: () => void): Promise<void> {
  if (!resp.body) {
    res.end();
    return;
  }
  const readable = Readable.fromWeb(resp.body as never);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    readable.on("error", () => {
      try {
        readable.unpipe(res);
      } catch {
        // already detached
      }
      done();
    });
    res.on("error", done);
    res.on("finish", () => done());
    // A client that disconnects mid-response makes res emit "close" without
    // "finish". Settle anyway so the caller's finally still runs (request record
    // + LLM capture of the partial body) and stop pulling from the upstream.
    res.on("close", () => {
      if (!res.writableFinished) {
        readable.destroy();
      }
      done();
    });
    if (onChunk || onActivity) {
      let capturing = Boolean(onChunk);
      readable.on("data", (chunk: Buffer | string) => {
        onActivity?.();
        if (!capturing || !onChunk) {
          return;
        }
        try {
          capturing = onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch {
          capturing = false;
        }
      });
    }
    readable.pipe(res);
  });
}

// Bun/undici fetch can keep a streamed body pending after AbortSignal fires.
// Reject as soon as we abort so serve() can record the 504 and not hang.
function fetchOrAbort(upstream: URL, init: RequestInit, onAbort: () => Error): Promise<Response> {
  const signal = init.signal;
  if (!signal) {
    return fetch(upstream, init);
  }
  return new Promise((resolve, reject) => {
    const fail = (): void => reject(onAbort());
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    fetch(upstream, init).then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
  });
}

function tapRequestBody(req: IncomingMessage, onActivity: () => void): PassThrough {
  const tap = new PassThrough();
  req.on("data", (chunk: Buffer | string) => {
    onActivity();
    tap.write(chunk);
  });
  req.on("end", () => tap.end());
  req.on("error", (err) => tap.destroy(err instanceof Error ? err : new Error(String(err))));
  return tap;
}

function contentLengthOf(req: IncomingMessage): number | undefined {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// True when the request body carries a real content-encoding (not identity),
// meaning the buffered bytes would not be parseable as the completion body.
function requestIsEncoded(req: IncomingMessage): boolean {
  const encoding = req.headers["content-encoding"];
  if (typeof encoding !== "string") {
    return false;
  }
  const value = encoding.trim().toLowerCase();
  return value !== "" && value !== "identity";
}

// Read the request body into a Buffer, enforcing a hard byte ceiling at read
// time. node:http frames the body to Content-Length, so the ceiling is a
// defensive invariant local to the read (independent of the caller's guard)
// rather than a fix for a reachable overflow.
function readRequestBody(req: IncomingMessage, maxBytes: number, onActivity?: () => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      chunks = [];
      req.destroy();
      reject(err);
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      onActivity?.();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new Error("request body exceeds capture cap"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

function capturePeer(req: IncomingMessage): { address: string; port: number } | undefined {
  const port = req.socket.remotePort;
  if (!Number.isInteger(port) || port === undefined || port <= 0) {
    return undefined;
  }
  return { address: req.socket.remoteAddress ?? "", port };
}

function stripLlmCallerHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (isLlmCallerHeader(key)) {
      delete headers[key];
    }
  }
}

// Wrap a capture recorder so no method it defines — including a throwing
// property getter for maxBytes — can ever escape into the proxy request path.
// Capture is strictly best-effort; the proxied request must be unaffected.
type HttpCaptureTee = {
  readonly maxBytes: number;
  setRequestBody(body: Buffer, opts?: { omitted?: boolean }): void;
  setResponseContentType(contentType: string): void;
  appendResponse(chunk: Buffer): boolean;
  finish(meta: { status: number; durationMs: number; requestId: string; traceId?: string; timestamp: string }): void | Promise<void>;
};

function combineHttpTees(tees: HttpCaptureTee[]): HttpCaptureTee | undefined {
  if (tees.length === 0) {
    return undefined;
  }
  if (tees.length === 1) {
    return tees[0];
  }
  return {
    maxBytes: Math.max(...tees.map((tee) => tee.maxBytes)),
    setRequestBody: (body, opts) => {
      for (const tee of tees) {
        tee.setRequestBody(body, opts);
      }
    },
    setResponseContentType: (contentType) => {
      for (const tee of tees) {
        tee.setResponseContentType(contentType);
      }
    },
    appendResponse: (chunk) => {
      let keep = false;
      for (const tee of tees) {
        if (tee.appendResponse(chunk)) {
          keep = true;
        }
      }
      return keep;
    },
    finish: async (meta) => {
      await Promise.all(tees.map((tee) => tee.finish(meta)));
    },
  };
}

function safeHttpTee(inner: LlmCaptureRecorder | TrafficCaptureRecorder): HttpCaptureTee {
  let maxBytes = 0;
  try {
    maxBytes = inner.maxBytes;
  } catch {
    maxBytes = 0;
  }
  return {
    maxBytes,
    setRequestBody: (body, opts) => {
      try {
        inner.setRequestBody(body, opts);
      } catch {
        // best-effort
      }
    },
    setResponseContentType: (contentType) => {
      try {
        inner.setResponseContentType(contentType);
      } catch {
        // best-effort
      }
    },
    appendResponse: (chunk) => {
      try {
        return inner.appendResponse(chunk);
      } catch {
        return false;
      }
    },
    finish: (meta) => {
      try {
        return inner.finish(meta);
      } catch {
        return undefined;
      }
    },
  };
}

export function proxyUpgradeRequest(upstream: URL): typeof httpRequest {
  return (upstream.protocol === "https:" ? httpsRequest : httpRequest) as typeof httpRequest;
}

export function forwardedRequestUrl(route: RouteConfig, inboundUrl: string): string {
  return route.strip_prefix ? stripMatchPrefix(inboundUrl, route.match.path) : inboundUrl;
}

export function resolveProxyTarget(upstreamUrl: string, requestUrl: string): URL {
  const configured = new URL(upstreamUrl);
  const resolved = new URL(requestUrl || "/", configured);
  const pinned = new URL(configured.href);
  pinned.pathname = singleSlashPath(resolved.pathname);
  pinned.search = resolved.search;
  pinned.hash = "";
  if (pinned.origin !== configured.origin) {
    throw newError(KindProxy, "refusing to proxy to a different origin");
  }
  return pinned;
}

function singleSlashPath(pathname: string): string {
  const withSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withSlash.replace(/^\/+/, "/");
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

export function matchRoute(routes: RouteConfig[], req: IncomingMessage): RouteConfig | undefined {
  const host = (req.headers.host ?? "").split(":")[0] ?? "";
  const path = req.url ?? "/";
  return routes.find((route) => {
    // grpc routes have their own dedicated listener; never let one (with its
    // empty match) catch HTTP traffic on the shared proxy.
    if (isGrpcRoute(route)) {
      return false;
    }
    const hostOk = route.match.host === "" || route.match.host === host;
    const pathOk = route.match.path === "" || path.startsWith(route.match.path);
    return hostOk && pathOk;
  });
}

export class TokenEndpoint {
  private server?: Server;
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly secret: string,
    private readonly tokens: TokenManager,
    private allowed: readonly TokenMint[] = [],
  ) {}

  isRunning(): boolean {
    return this.server?.listening === true;
  }

  replaceAllowed(allowed: readonly TokenMint[]): void {
    this.allowed = allowed;
  }

  listenPort(): number {
    const addr = this.server?.address();
    if (typeof addr === "object" && addr) {
      return addr.port;
    }
    return this.port;
  }

  listenBind(): { host: string; port: number } {
    return { host: this.host || "127.0.0.1", port: this.listenPort() };
  }

  start(): Promise<void> {
    const host = this.host || "127.0.0.1";
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(newError(KindProxy, `refusing to bind token endpoint to ${host}`));
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.serve(req, res);
      });
      this.server.on("error", (err) => reject(wrapError(KindProxy, "token endpoint listen failed", err)));
      this.server.listen(this.port, host, () => resolve());
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      writePlain(res, 403, "forbidden");
      return;
    }
    if ((req.headers[INTERNAL_TOKEN_HEADER] ?? "") !== this.secret) {
      writePlain(res, 401, "unauthorized");
      return;
    }
    if (req.url?.startsWith("/token") !== true) {
      writePlain(res, 404, "not found");
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const identity = url.searchParams.get("identity") ?? "user";
    const audience = url.searchParams.get("audience") ?? "";
    if (!tokenMintAllowed(this.allowed, identity, audience)) {
      writePlain(res, 403, "forbidden");
      return;
    }
    try {
      const tok = await this.tokens.get(identity, audience, []);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: tok.accessToken,
          token_type: tok.tokenType,
          expires_at: tok.expiresAt.toISOString(),
          identity: tok.identity,
        }),
      );
    } catch (err) {
      if (isTokenMintRateLimited(err)) {
        res.setHeader("retry-after", String(TOKEN_MINT_WINDOW_MS / 1000));
        writePlain(res, 429, "too many requests");
        return;
      }
      writePlain(res, 500, "token error");
    }
  }
}
