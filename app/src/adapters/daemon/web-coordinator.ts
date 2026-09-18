import { LOCALHOST, type DevctlConfig } from "../../domain/config/types.ts";
import { formatHostPort } from "../../domain/net/hosts.ts";
import type { McpHost, WebListener, WebListenerFactory } from "../../ports/web-host.ts";
import { humanMessage } from "../../shared/errors.ts";
import { readOrCreateWebToken } from "../storage/storage.ts";

export type WebCoordinatorDeps = {
  repoRoot: () => string;
  cfg: () => DevctlConfig;
  createListener: WebListenerFactory;
  hostApi: () => McpHost;
  log: (service: string, level: string, message: string) => void;
};

export class WebCoordinator {
  private listener?: WebListener;
  private token: string;
  private readonly deps: WebCoordinatorDeps;

  constructor(deps: WebCoordinatorDeps) {
    this.deps = deps;
    this.token = readOrCreateWebToken(deps.repoRoot());
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
    // Carry the token in the URL fragment, not the query string: a fragment is
    // never sent as Referer, is not written to proxy access logs, and is not
    // forwarded upstream. The SPA reads it from location.hash on load.
    return `${base}#token=${encodeURIComponent(this.token)}`;
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
  }

  async sync(): Promise<void> {
    const cfg = this.deps.cfg();
    const host = cfg.web.listen.host || LOCALHOST;
    const port = cfg.web.listen.port;
    const wantEnabled = cfg.web.enabled;
    const running = this.listener?.isRunning() === true;
    const sameBind = running && this.listener !== undefined && this.listener.listenPort() === port && this.listener.address() === formatHostPort(host, port);
    if (wantEnabled && sameBind) {
      return;
    }
    const rebind = (): void => {
      void (async () => {
        try {
          await this.stop();
          if (wantEnabled) {
            await this.start();
          }
        } catch (err) {
          this.deps.log("web", "ERROR", `web ${humanMessage(err)}`);
        }
      })();
    };
    if (running) {
      // Dropping the listener inside an in-flight /api/control request would
      // prevent the JSON reply from reaching the browser. Finish this turn first.
      setTimeout(rebind, 0);
      return;
    }
    if (wantEnabled) {
      await this.start();
    }
  }

  private async bind(): Promise<void> {
    if (this.listener?.isRunning()) {
      return;
    }
    const listen = this.deps.cfg().web.listen;
    this.token = readOrCreateWebToken(this.deps.repoRoot());
    this.listener = this.deps.createListener({
      host: listen.host || LOCALHOST,
      port: listen.port,
      token: this.token,
      hostApi: this.deps.hostApi(),
      onEvent: (level, message) => this.deps.log("web", level, `web ${message}`),
    });
    await this.listener.start();
    this.deps.log("devctl", "INFO", `web UI listening on ${this.endpoint()}`);
  }
}
