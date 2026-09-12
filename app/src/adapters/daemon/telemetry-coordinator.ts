import type { DevctlConfig } from "../../domain/config/types.ts";
import { LOCALHOST } from "../../domain/config/types.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import { OtlpHttpServer } from "../telemetry/otlp-http.ts";

export type TelemetryCoordinatorDeps = {
  cfg: () => DevctlConfig;
  logs: LogStore;
  spans: SpanStore;
  log: (service: string, level: string, message: string) => void;
};

export class TelemetryCoordinator {
  private server?: OtlpHttpServer;
  private readonly deps: TelemetryCoordinatorDeps;

  constructor(deps: TelemetryCoordinatorDeps) {
    this.deps = deps;
  }

  endpoint(): string {
    if (!this.server?.isRunning()) {
      return "";
    }
    return this.server.endpoint();
  }

  async start(): Promise<void> {
    const cfg = this.deps.cfg().telemetry.otlp;
    if (!cfg.enabled) {
      return;
    }
    if (this.server?.isRunning()) {
      return;
    }
    this.server = new OtlpHttpServer({
      host: cfg.listen.host || LOCALHOST,
      port: cfg.listen.port,
      logs: this.deps.logs,
      spans: this.deps.spans,
    });
    await this.server.start();
    this.deps.log("devctl", "INFO", `OTLP/HTTP+JSON listening on ${this.server.address()}`);
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
  }
}
