import { type DevctlConfig, isGrpcRoute } from "../../domain/config/types.ts";
import { declaredTokenMints } from "../../domain/identity/identity.ts";
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

  get boundTokenURL(): string {
    return this.boundURL;
  }

  get isSuppressed(): boolean {
    return this.suppressed;
  }

  setSuppressed(value: boolean): void {
    this.suppressed = value;
  }

  async start(): Promise<void> {
    if (this.server?.isRunning()) {
      return;
    }
    this.server = new ProxyServer(
      this.deps.cfg().proxy,
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
    const cfg = this.deps.cfg();
    if (cfg.proxy.token_endpoint.enabled) {
      this.tokenEP = new TokenEndpoint(
        cfg.proxy.token_endpoint.host || "127.0.0.1",
        cfg.proxy.token_endpoint.port,
        this.deps.internalTok(),
        this.deps.tokens,
        declaredTokenMints(cfg),
      );
      await this.tokenEP.start();
      this.boundURL = `http://127.0.0.1:${this.tokenEP.listenPort()}/token`;
    }
    // A dedicated loopback HTTP/2 listener per grpc route, sharing the same
    // token/log/bus/detector plumbing as the HTTP proxy.
    for (const route of cfg.proxy.routes.filter(isGrpcRoute)) {
      const grpc = new GrpcProxyServer(route, this.deps.tokens, this.deps.logs, this.deps.bus, this.deps.detector, this.deps.spans, this.deps.traffic);
      await grpc.start();
      this.grpc.push(grpc);
    }
    this.deps.persistState();
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    await this.tokenEP?.stop();
    await Promise.all(this.grpc.map((grpc) => grpc.stop()));
    this.grpc = [];
    this.deps.persistState();
  }
}
