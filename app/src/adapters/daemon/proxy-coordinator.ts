import type { DevctlConfig } from "../../domain/config/types.ts";
import type { Bus } from "../../shared/events.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { TokenManager } from "../google/token.ts";
import { ProxyServer, TokenEndpoint, type ProxyMiddleware } from "../proxy/proxy.ts";
import type { Detector } from "../secrets/detector.ts";

export type ProxyCoordinatorDeps = {
  cfg: () => DevctlConfig;
  tokens: TokenManager;
  logs: LogStore;
  bus: Bus;
  detector: Detector;
  internalTok: () => string;
  middleware: () => ProxyMiddleware[];
  persistState: () => void;
};

export class ProxyCoordinator {
  private server?: ProxyServer;
  private tokenEP?: TokenEndpoint;
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
    );
    await this.server.start();
    const cfg = this.deps.cfg();
    if (cfg.proxy.token_endpoint.enabled) {
      this.tokenEP = new TokenEndpoint(
        cfg.proxy.token_endpoint.host || "127.0.0.1",
        cfg.proxy.token_endpoint.port,
        this.deps.internalTok(),
        this.deps.tokens,
      );
      await this.tokenEP.start();
      this.boundURL = `http://127.0.0.1:${this.tokenEP.listenPort()}/token`;
    }
    this.deps.persistState();
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    await this.tokenEP?.stop();
    this.deps.persistState();
  }
}
