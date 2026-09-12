import type { DevctlConfig } from "../../domain/config/types.ts";
import type { McpHost, WebListener, WebListenerFactory } from "../../ports/web-host.ts";

export type WebCoordinatorDeps = {
  cfg: () => DevctlConfig;
  createListener: WebListenerFactory;
  hostApi: () => McpHost;
  log: (service: string, level: string, message: string) => void;
};

export class WebCoordinator {
  private listener?: WebListener;
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

  async start(): Promise<void> {
    if (!this.deps.cfg().web.enabled) {
      return;
    }
    await this.bind();
  }

  async startExplicit(): Promise<void> {
    await this.bind();
  }

  async stop(): Promise<void> {
    await this.listener?.stop();
    this.listener = undefined;
  }

  private async bind(): Promise<void> {
    if (this.listener?.isRunning()) {
      return;
    }
    const listen = this.deps.cfg().web.listen;
    this.listener = this.deps.createListener({
      port: listen.port,
      hostApi: this.deps.hostApi(),
      onEvent: (level, message) => this.deps.log("web", level, `web ${message}`),
    });
    await this.listener.start();
    this.deps.log("devctl", "INFO", `web UI listening on ${this.endpoint()}`);
  }
}
