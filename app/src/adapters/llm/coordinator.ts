import {
  LOCALHOST,
  llmAuthHeader,
  llmManagementPort,
  llmSourcePort,
  type DevctlConfig,
  type LlmSourceConfig,
  type RouteConfig,
} from "../../domain/config/types.ts";
import { llmPollSeconds, stripLlmBodies, type LlmCallIngest } from "../../domain/llm/llm.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import type { LlmSourceContext, LlmSourceFactory } from "../../ports/llm-source.ts";
import { injectIdentityHeaders } from "../proxy/proxy.ts";
import type { TokenManager } from "../google/token.ts";
import { LlmSourceHttpError } from "./litellm.ts";

const MS_PER_SECOND = 1000;

export type LlmCoordinatorDeps = {
  cfg: () => DevctlConfig;
  store: LlmCallStore;
  factory: () => LlmSourceFactory;
  ports: () => Map<string, Record<string, number>>;
  log: (service: string, level: string, message: string) => void;
  tokens?: TokenManager;
  env?: NodeJS.Dict<string>;
};

export class LlmCoordinator {
  private readonly deps: LlmCoordinatorDeps;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly since = new Map<string, string>();
  private running = false;

  constructor(deps: LlmCoordinatorDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    await this.stop();
    const cfg = this.deps.cfg().llm;
    if (!cfg.enabled) {
      return;
    }
    this.running = true;
    for (const source of cfg.sources) {
      void this.pollSource(source);
      const ms = llmPollSeconds(source.poll_seconds) * MS_PER_SECOND;
      this.timers.set(source.name, setInterval(() => {
        void this.pollSource(source);
      }, ms));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  async applyConfig(): Promise<void> {
    await this.start();
  }

  private async pollSource(source: LlmSourceConfig): Promise<void> {
    if (!this.running) {
      return;
    }
    const live = this.deps.cfg().llm.sources.find((item) => item.name === source.name) ?? source;
    try {
      const calls = await this.fetchSource(live);
      this.deps.store.clearSourceError(live.name);
      this.deps.store.upsert(live.capture.prompts ? calls : calls.map(stripLlmBodies));
      const newest = newestTimestamp(calls);
      if (newest) {
        this.since.set(live.name, newest);
      }
    } catch (err) {
      const status = err instanceof LlmSourceHttpError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.store.setSourceError(live.name, message, status);
      this.deps.log("devctl", "WARN", `llm source ${live.name}: ${message}`);
    }
  }

  private async fetchSource(source: LlmSourceConfig): Promise<LlmCallIngest[]> {
    const driver = this.deps.factory().lookup(source.type);
    if (!driver) {
      throw new Error(`unknown llm source type ${source.type}`);
    }
    const ctx = await this.resolveContext(source);
    return driver.fetch(source, ctx);
  }

  private async resolveContext(source: LlmSourceConfig): Promise<LlmSourceContext> {
    const headers: Record<string, string> = { ...source.headers, accept: "application/json" };
    const route = namedRoute(this.deps.cfg(), source.via.route);
    if (route) {
      await injectIdentityHeaders(route, headers, this.deps.tokens);
    }
    applySourceAuth(headers, source, this.deps.env ?? process.env);
    return {
      baseUrl: this.managementBaseUrl(source, route),
      pathPrefix: source.path_prefix,
      headers,
      since: this.since.get(source.name),
    };
  }

  private managementBaseUrl(source: LlmSourceConfig, route: RouteConfig | undefined): string {
    if (source.management_endpoint.trim() !== "") {
      return source.management_endpoint.trim();
    }
    if (source.management_service.trim() !== "") {
      return this.serviceBaseUrl(source.management_service, llmManagementPort(source));
    }
    if (source.endpoint.trim() !== "") {
      return source.endpoint.trim();
    }
    if (source.service.trim() !== "") {
      return this.serviceBaseUrl(source.service, llmSourcePort(source));
    }
    if (!route) {
      throw new Error("llm source has no management hop");
    }
    return this.routeBaseUrl(route);
  }

  private serviceBaseUrl(service: string, portName: string): string {
    const port = this.deps.ports().get(service)?.[portName];
    if (port === undefined) {
      throw new Error(`upstream service ${service} is not running`);
    }
    return `http://${LOCALHOST}:${port}`;
  }

  private routeBaseUrl(route: RouteConfig): string {
    const service = route.upstream.service ?? "";
    if (service !== "") {
      return this.serviceBaseUrl(service, route.upstream.port || "http");
    }
    if (route.upstream.url.trim() === "") {
      throw new Error(`proxy route ${route.name} has no upstream`);
    }
    return route.upstream.url;
  }
}

function namedRoute(cfg: DevctlConfig, name: string): RouteConfig | undefined {
  if (name.trim() === "") {
    return undefined;
  }
  return cfg.proxy.routes.find((route) => route.name === name);
}

function applySourceAuth(headers: Record<string, string>, source: LlmSourceConfig, env: NodeJS.Dict<string>): void {
  const tokenEnv = source.auth.token_env.trim();
  if (tokenEnv === "") {
    return;
  }
  const token = env[tokenEnv] ?? "";
  if (token.trim() === "") {
    throw new Error(`${tokenEnv} is not set`);
  }
  const header = llmAuthHeader(source.auth);
  const value = authorizationValue(header, token.trim());
  headers[header] = value;
  if (header.toLowerCase() === "authorization") {
    headers.authorization = value;
  }
}

function authorizationValue(header: string, token: string): string {
  if (header.toLowerCase() !== "authorization") {
    return token;
  }
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

function newestTimestamp(calls: Array<{ timestamp: string }>): string | undefined {
  if (calls.length === 0) {
    return undefined;
  }
  return calls.reduce((max, call) => (call.timestamp > max ? call.timestamp : max), calls[0]?.timestamp ?? "");
}
