import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { type ProxyConfig, type RouteConfig, listenAddress } from "./config/index.ts";
import { KindProxy, newError, wrapError } from "./errors.ts";
import { Bus, newEvent, ProxyRequest, ProxyStarted, ProxyStopped } from "./events.ts";
import { fromRoute, tokenIdentityKey } from "./identity.ts";
import { type LogManager } from "./logs.ts";
import { type Detector } from "./secrets.ts";
import { type TokenManager } from "./token.ts";

export const REQUEST_ID_HEADER = "x-devctl-request-id";
export const INTERNAL_TOKEN_HEADER = "x-devctl-internal-token";

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
};

export class ProxyServer {
  private readonly cfg: ProxyConfig;
  private readonly tokens?: TokenManager;
  private readonly logs?: LogManager;
  private readonly bus?: Bus;
  private readonly detector?: Detector;
  private readonly middleware: ProxyMiddleware[];
  private server?: Server;
  private running = false;
  private addr = "";

  constructor(
    cfg: ProxyConfig,
    tokens?: TokenManager,
    logs?: LogManager,
    bus?: Bus,
    detector?: Detector,
    middleware: ProxyMiddleware[] = [],
  ) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.logs = logs;
    this.bus = bus;
    this.detector = detector;
    this.middleware = middleware;
  }

  address(): string {
    return this.addr || listenAddress(this.cfg.listen);
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): Promise<void> {
    if (this.cfg.listen.host === "0.0.0.0") {
      return Promise.reject(newError(KindProxy, "refusing to bind proxy to 0.0.0.0 without explicit unsafe configuration"));
    }
    const host = this.cfg.listen.host || "127.0.0.1";
    if (this.cfg.listen.port === 0) {
      return Promise.reject(newError(KindProxy, "proxy.listen.port is required when the proxy is enabled"));
    }
    const port = this.cfg.listen.port;
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.serve(req, res);
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
    return new Promise((resolve) => {
      server.close(() => {
        this.running = false;
        this.bus?.publish(newEvent(ProxyStopped, "", {}));
        resolve();
      });
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestID = req.headers[REQUEST_ID_HEADER]?.toString() || randomBytes(8).toString("hex");
    const route = matchRoute(this.cfg.routes, req);
    if (!route) {
      writePlain(res, 404, "no matching proxy route");
      return;
    }
    const ident = fromRoute(route.auth);
    const identityKey = tokenIdentityKey(ident);
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
      headers[REQUEST_ID_HEADER] = requestID;
      if (this.middleware.length === 0) {
        await injectIdentityHeaders(route, headers, this.tokens);
      }
      for (const hook of this.middleware) {
        await hook.apply({ route, headers, tokens: this.tokens });
      }
      const upstream = resolveProxyTarget(route.upstream.url, req.url ?? "/");
      const body = req.method && req.method !== "GET" && req.method !== "HEAD" ? req : undefined;
      const resp = await fetch(upstream, {
        method: req.method,
        headers,
        body: body as unknown as BodyInit | undefined,
        redirect: "manual",
        // @ts-expect-error Bun/undici duplex for streamed request bodies
        duplex: body ? "half" : undefined,
      });
      res.statusCode = resp.status;
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
      await pipeResponse(resp, res);
      const duration = Date.now() - started;
      const path = req.url ?? "/";
      this.logs?.append({
        timestamp: new Date().toISOString(),
        service: "proxy",
        source: "proxy",
        level: resp.status >= 400 ? "WARN" : "INFO",
        message: `${req.method} ${path} route=${route.name} identity=${identityKey} status=${resp.status} duration=${duration}ms`,
        pid: 0,
        request_id: requestID,
        identity: identityKey,
      });
      this.bus?.publish(newEvent(ProxyRequest, route.name, { status: resp.status, request_id: requestID, duration, identity: identityKey }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : "proxy error";
      this.logs?.append({
        timestamp: new Date().toISOString(),
        service: "proxy",
        source: "proxy",
        level: "ERROR",
        message: `${req.method} ${req.url ?? "/"} route=${route.name} identity=${identityKey} error=${detail}`,
        pid: 0,
        request_id: requestID,
        identity: identityKey,
      });
      writePlain(res, 502, "proxy error");
    }
  }

}

export async function injectIdentityHeaders(
  route: RouteConfig,
  headers: Record<string, string>,
  tokens?: TokenManager,
): Promise<void> {
  const authType = route.auth.type.toLowerCase();
  if (authType === "" || authType === "none") {
    return;
  }
  if (!tokens) {
    throw newError(KindProxy, "token manager unavailable");
  }
  const ident = fromRoute(route.auth);
  const tok = await tokens.get(tokenIdentityKey(ident), route.auth.audience, []);
  headers.authorization = `Bearer ${tok.accessToken}`;
}

async function pipeResponse(resp: Response, res: ServerResponse): Promise<void> {
  if (!resp.body) {
    res.end();
    return;
  }
  const readable = Readable.fromWeb(resp.body as never);
  await new Promise<void>((resolve, reject) => {
    readable.on("error", reject);
    res.on("error", reject);
    res.on("finish", resolve);
    readable.pipe(res);
  });
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
  ) {}

  listenPort(): number {
    const addr = this.server?.address();
    if (typeof addr === "object" && addr) {
      return addr.port;
    }
    return this.port;
  }

  start(): Promise<void> {
    const host = this.host || "127.0.0.1";
    if (host === "0.0.0.0") {
      return Promise.reject(newError(KindProxy, "refusing to bind token endpoint to 0.0.0.0"));
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
    if (!isLoopback(req.socket.remoteAddress)) {
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
    } catch {
      writePlain(res, 500, "token error");
    }
  }
}

function isLoopback(addr?: string): boolean {
  if (!addr) {
    return true;
  }
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
