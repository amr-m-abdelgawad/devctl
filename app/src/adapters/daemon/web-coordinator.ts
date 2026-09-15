import { LOCALHOST, type DevctlConfig } from "../../domain/config/types.ts";
import type { HttpClientRuntime } from "../../ports/http-client.ts";
import type { McpHost, WebListener, WebListenerFactory } from "../../ports/web-host.ts";
import { randomSecret } from "../storage/storage.ts";

export type WebCoordinatorDeps = {
  cfg: () => DevctlConfig;
  createListener: WebListenerFactory;
  hostApi: () => McpHost;
  httpClient: () => HttpClientRuntime;
  log: (service: string, level: string, message: string) => void;
};

export class WebCoordinator {
  private listener?: WebListener;
  private token = "";
  private readonly deps: WebCoordinatorDeps;

  constructor(deps: WebCoordinatorDeps) {
    this.deps = deps;
  }

  get instance(): WebListener | undefined {
    return this.listener;
  }

  address(): string {
    return this.listener?.isRunning() ? this.listener.address() : "";
  }

  endpoint(): string {
    const addr = this.address();
    return addr === "" ? "" : `http://${addr}/`;
  }

  controlUrl(): string {
    const base = this.endpoint();
    if (base === "" || this.token === "") {
      return base;
    }
    return `${base}?token=${encodeURIComponent(this.token)}`;
  }

  async start(): Promise<void> {
    if (!this.deps.cfg().web.enabled) {
      return;
    }
    await this.bind();
  }

  async startExplicit(): Promise<string> {
    await this.bind();
    return this.controlUrl();
  }

  async stop(): Promise<void> {
    await this.listener?.stop();
    this.listener = undefined;
    this.token = "";
  }

  private async bind(): Promise<void> {
    if (this.listener?.isRunning()) {
      return;
    }
    const listen = this.deps.cfg().web.listen;
    this.token = randomSecret();
    this.listener = this.deps.createListener({
      host: listen.host || LOCALHOST,
      port: listen.port,
      token: this.token,
      hostApi: this.deps.hostApi(),
      httpClient: this.deps.httpClient(),
      onEvent: (level, message) => this.deps.log("web", level, `web ${message}`),
    });
    await this.listener.start();
    this.deps.log("devctl", "INFO", `web UI listening on ${this.endpoint()}`);
  }
}
