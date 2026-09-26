import { type DevctlConfig, isGrpcRoute, type ProxyConfig, type RouteConfig, type TokenEndpointConfig } from "../../domain/config/types.ts";
import { declaredTokenMints } from "../../domain/identity/identity.ts";
import { listenKey, sameListen } from "../../domain/proxy/listen.ts";
import type { Bus } from "../../shared/events.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import type { TokenManager } from "../google/token.ts";
import type { HttpRecipeRuntime } from "../../ports/http-recipe-runtime.ts";
import type { LlmCaptureSink } from "../../ports/llm-capture.ts";
import type { TrafficCaptureSink } from "../../ports/traffic-capture.ts";
import { GrpcProxyServer } from "../proxy/grpc-proxy.ts";
import { ProxyServer, TokenEndpoint, type ProxyMiddleware } from "../proxy/proxy.ts";
import type { Detector } from "../secrets/detector.ts";

export type ProxyCoordinatorDeps = {
  cfg: () => DevctlConfig;
  // Live assigned-ports map, keyed by service name then port name. Feeds the
  // proxy's request-time resolution of service-reference upstreams.
  ports: () => Map<string, Record<string, number>>;
  tokens: TokenManager;
  recipes: HttpRecipeRuntime;
  logs: LogStore;
  spans: SpanStore;
  bus: Bus;
  detector: Detector;
  internalTok: () => string;
  middleware: () => ProxyMiddleware[];
  // Optional LLM body-capture sink, shared (singleton) so it survives proxy
  // restarts and reads live config; passed to each ProxyServer instance.
  capture?: LlmCaptureSink;
  traffic?: TrafficCaptureSink;
  persistState: () => void;
};

export class ProxyCoordinator {
  private server?: ProxyServer;
  private tokenEP?: TokenEndpoint;
  private grpc: GrpcProxyServer[] = [];
  private boundURL = "";
  // Set only by an explicit "proxy_stop" RPC, cleared only by an explicit
  // "proxy_start" one — never by reload() or an internal stop() call
  // (config change, shutdown) — so a user who deliberately stopped the
  // proxy doesn't have it silently come back on the next service start.
  private suppressed = false;
  private readonly deps: ProxyCoordinatorDeps;

  constructor(deps: ProxyCoordinatorDeps) {
    this.deps = deps;
  }

  get instance(): ProxyServer | undefined {
    return this.server;
  }

  get tokenEndpoint(): TokenEndpoint | undefined {
    return this.tokenEP;
  }

  get grpcServers(): readonly GrpcProxyServer[] {
    return this.grpc;
  }

  get boundTokenURL(): string {
    return this.boundURL;
  }

  get isSuppressed(): boolean {
    return this.suppressed;
  }

  isRunning(): boolean {
    return this.server?.isRunning() ?? false;
  }

  setSuppressed(value: boolean): void {
    this.suppressed = value;
  }

  async start(): Promise<void> {
    if (this.server?.isRunning()) {
      return;
    }
    try {
      await this.startHttp(this.deps.cfg().proxy);
      await this.syncTokenEndpoint();
      await this.syncGrpcListeners();
    } catch (err) {
      // All or nothing: a half-bound proxy would read as running on the next
      // start() and let services launch against the listener that failed.
      await this.stop().catch(() => undefined);
      throw err;
    }
    this.deps.persistState();
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    await this.tokenEP?.stop();
    this.tokenEP = undefined;
    this.boundURL = "";
    await Promise.all(this.grpc.map((grpc) => grpc.stop()));
    this.grpc = [];
    this.deps.persistState();
  }

  // Reload entry: keep bound sockets when listen is unchanged. Starts a
  // stopped proxy when config re-enables it, unless the user suppressed it.
  // Stops when the live proxy becomes disabled.
  async applyConfig(): Promise<void> {
    const cfg = this.deps.cfg();
    const proxy = cfg.proxy;
    const running = this.isRunning();
    if (!running) {
      if (proxy.enabled && !this.suppressed) {
        await this.start();
      }
      return;
    }
    if (!proxy.enabled) {
      await this.stop();
      return;
    }
    const httpRecreate = !sameListen(this.server?.listenBind(), proxy.listen);
    const tokenRecreate = tokenListenRecreated(this.tokenEP, proxy.token_endpoint);
    const grpcRecreate = grpcListenRecreated(this.grpc, proxy.routes);
    const recreating = httpRecreate || tokenRecreate || grpcRecreate;
    if (recreating) {
      this.proxyLog("INFO", "proxy restarting — config reload");
    }
    if (httpRecreate) {
      await this.server?.stop();
      await this.startHttp(proxy);
    } else if (this.server) {
      this.server.replaceConfig(proxy);
      this.server.setMiddleware(this.deps.middleware());
    }
    await this.syncTokenEndpoint();
    await this.syncGrpcListeners();
    if (!recreating) {
      this.proxyLog("INFO", "proxy routes reloaded");
    }
    this.deps.persistState();
  }

  private async startHttp(proxy: ProxyConfig): Promise<void> {
    this.server = new ProxyServer(
      proxy,
      this.deps.tokens,
      this.deps.logs,
      this.deps.bus,
      this.deps.detector,
      this.deps.middleware(),
      (service, port) => this.deps.ports().get(service)?.[port || "http"],
      this.deps.spans,
      this.deps.recipes,
      this.deps.capture,
      this.deps.traffic,
    );
    await this.server.start();
  }

  private async syncTokenEndpoint(): Promise<void> {
    const cfg = this.deps.cfg();
    const next = cfg.proxy.token_endpoint;
    const running = this.tokenEP?.isRunning() ?? false;
    if (!next.enabled) {
      if (running) {
        await this.tokenEP?.stop();
      }
      this.tokenEP = undefined;
      this.boundURL = "";
      return;
    }
    const allowed = declaredTokenMints(cfg);
    if (running && this.tokenEP && sameListen({ host: tokenHost(next), port: next.port }, this.tokenEP.listenBind())) {
      this.tokenEP.replaceAllowed(allowed);
      return;
    }
    await this.tokenEP?.stop();
    this.tokenEP = new TokenEndpoint(
      tokenHost(next),
      next.port,
      this.deps.internalTok(),
      this.deps.tokens,
      allowed,
    );
    await this.tokenEP.start();
    this.boundURL = `http://127.0.0.1:${this.tokenEP.listenPort()}/token`;
  }

  private async syncGrpcListeners(): Promise<void> {
    const nextRoutes = this.deps.cfg().proxy.routes.filter(isGrpcRoute);
    const remaining = [...this.grpc];
    const next: GrpcProxyServer[] = [];
    for (const route of nextRoutes) {
      const idx = remaining.findIndex((grpc) => grpc.sameListen(route));
      if (idx >= 0) {
        const existing = remaining.splice(idx, 1)[0];
        if (existing) {
          existing.replaceRoute(route);
          next.push(existing);
        }
        continue;
      }
      const grpc = new GrpcProxyServer(route, this.deps.tokens, this.deps.logs, this.deps.bus, this.deps.detector, this.deps.spans, this.deps.traffic);
      try {
        await grpc.start();
      } catch (err) {
        // Keep every listener reachable from this.grpc so stop() releases it.
        this.grpc = [...next, ...remaining];
        throw err;
      }
      next.push(grpc);
    }
    await Promise.all(remaining.map((grpc) => grpc.stop()));
    this.grpc = next;
  }

  private proxyLog(level: string, message: string): void {
    this.deps.logs.append({
      timestamp: new Date().toISOString(),
      service: "proxy",
      source: "proxy",
      level,
      message,
      pid: 0,
    });
  }
}

function tokenHost(cfg: TokenEndpointConfig): string {
  return cfg.host || "127.0.0.1";
}

function tokenListenRecreated(current: TokenEndpoint | undefined, next: TokenEndpointConfig): boolean {
  if (!current?.isRunning() || !next.enabled) {
    return false;
  }
  return !sameListen({ host: tokenHost(next), port: next.port }, current.listenBind());
}

function grpcListenRecreated(current: readonly GrpcProxyServer[], routes: readonly RouteConfig[]): boolean {
  const nextByName = new Map(routes.filter(isGrpcRoute).map((route) => [route.name, listenKey(route.listen)] as const));
  for (const grpc of current) {
    const nextKey = nextByName.get(grpc.routeName());
    if (nextKey !== undefined && nextKey !== grpc.listenKey()) {
      return true;
    }
  }
  return false;
}
