import { isAbsolute, join } from "node:path";
import type { DevctlConfig, ServiceConfig } from "../../domain/config/types.ts";
import { listenAddress } from "../config/index.ts";
import { applyOtelExporterEnv } from "../../domain/telemetry/otel-env.ts";
import { envList, resolveEnvironment, runtimeForService, type EnvironmentSource } from "../environment/environment.ts";
import { secretManagerFetcher } from "../google/secret-manager.ts";
import type { TokenManager } from "../google/token.ts";
import type { TokenEndpoint } from "../proxy/proxy.ts";
import type { HttpRecipeRuntime } from "../../ports/http-recipe-runtime.ts";
import { httpRecipeEnvUrlKey } from "../../domain/config/types.ts";
import type { HttpValueMap } from "../config/refs.ts";
import { effectiveServiceEnv, resolveEnvironmentName, profileServiceEnvConfig } from "../../domain/service/environments.ts";

export type EnvironmentBridgeDeps = {
  cfg: () => DevctlConfig;
  ports: () => Map<string, Record<string, number>>;
  // The detected developer identity (gcloud/ADC email), injected as
  // DEVCTL_USER_EMAIL and resolved for ${identity.user}. "" when undetected.
  userEmail: () => string;
  proxy: () => { isRunning(): boolean; address(): string } | undefined;
  tokenEndpoint: () => TokenEndpoint | undefined;
  boundTokenURL: () => string;
  internalTok: () => string;
  tokens: TokenManager;
  recipes?: HttpRecipeRuntime;
  environmentSources: () => EnvironmentSource[] | undefined;
  otlpEndpoint: () => string;
};

export class EnvironmentBridge {
  // Per-service: the OS environment of whichever client (CLI/TUI) most
  // recently started/restarted it, in memory only. A service that has never
  // been started/restarted by a real client this way — an MCP-initiated
  // start, or a process adopted by recoverSession() — has no entry, and
  // resolveEnvironment() falls back to the daemon's own environment. This is
  // intentionally never persisted: it does not survive a daemon replacement,
  // which must be restarted by a real client to pick up fresh env again.
  readonly clientEnv = new Map<string, Record<string, string>>();
  // Per-service: the profile (name + resolved env) in effect the last time
  // this service was explicitly (re)started. Read by onExit's crash-restart
  // and restart()'s own respawn so that starting a *different* service under
  // a different profile — which moves the daemon-wide profile / profileEnv
  // used as the fallback below — can never change what an unrelated,
  // already-running service's next automatic restart resolves its
  // environment with. Same never-persisted rationale as clientEnv.
  readonly serviceProfile = new Map<string, string>();
  readonly serviceProfileEnv = new Map<string, Record<string, string>>();
  readonly serviceEnv = new Map<string, string>();
  readonly serviceStartedEnv = new Map<string, string>();
  profile = "";
  profileEnv: Record<string, string> = {};
  private readonly deps: EnvironmentBridgeDeps;

  constructor(deps: EnvironmentBridgeDeps) {
    this.deps = deps;
  }

  forget(name: string): void {
    this.clientEnv.delete(name);
    this.serviceProfile.delete(name);
    this.serviceProfileEnv.delete(name);
    // Keep `serviceEnv` — the user's overlay selection is session state and
    // must survive stop/start of the same still-configured service. forget()
    // only runs for services removed from config, which drop the map entry
    // below after persist so a stale name cannot linger.
    this.serviceEnv.delete(name);
    this.serviceStartedEnv.delete(name);
  }

  serviceWorkDir(svc: ServiceConfig): string {
    if (svc.working_dir !== "" && !isAbsolute(svc.working_dir)) {
      return join(this.deps.cfg().repoRoot, svc.working_dir);
    }
    return svc.working_dir;
  }

  async resolveServiceExecution(
    name: string,
    svc: ServiceConfig,
    profile: string,
    profileEnv: Record<string, string>,
    clientEnv?: Record<string, string>,
    includeProcess = true,
    selectedEnv?: string,
  ): Promise<{ env: Record<string, string>; workDir: string }> {
    const cfg = this.deps.cfg();
    const assigned = this.deps.ports().get(name) ?? Object.fromEntries(svc.ports.filter((port) => !port.auto).map((port) => [port.name, port.value]));
    const proxy = this.deps.proxy();
    const proxyURL = proxy?.isRunning() ? `http://${proxy.address()}` : cfg.proxy.enabled ? `http://${listenAddress(cfg.proxy.listen)}` : "";
    const userEmail = this.deps.userEmail();
    const envName = resolveEnvironmentName(svc, selectedEnv !== undefined ? selectedEnv : this.serviceEnv.get(name));
    const serviceCfg = envName === "" ? svc : { ...svc, environment: effectiveServiceEnv(svc, envName) };
    const profileServiceEnv = profileServiceEnvConfig(cfg, profile, name);
    const runtime = runtimeForService(name, "127.0.0.1", assigned, proxyURL, cfg.project.name, userEmail);
    if (envName !== "") {
      runtime.DEVCTL_SERVICE_ENV = envName;
    }
    if (!svc.container) {
      runtime.DEVCTL_INTERNAL_TOKEN = this.deps.internalTok();
      if (cfg.proxy.token_endpoint.enabled) {
        runtime.DEVCTL_TOKEN_URL = this.deps.boundTokenURL() || `http://127.0.0.1:${this.deps.tokenEndpoint()?.listenPort() || cfg.proxy.token_endpoint.port}/token`;
      }
      if (cfg.proxy.enabled) {
        Object.assign(runtime, this.httpExposeUrls(cfg));
      }
    }
    const resolved = await resolveEnvironment(cfg.repoRoot, {
      service: name,
      profile,
      serviceCfg,
      profileEnv,
      profileServiceEnv,
      assignedPorts: assigned,
      runtime,
      userEmail,
      cfg,
      http: this.httpValues(cfg),
      fetchSecret: secretManagerFetcher(async () => (await this.deps.tokens.get("user", "", [])).accessToken),
      pluginSources: this.deps.environmentSources(),
      clientEnv,
      includeProcess,
    });
    const workDir = svc.working_dir && !isAbsolute(svc.working_dir) ? join(cfg.repoRoot, svc.working_dir) : svc.working_dir;
    const env = envList(resolved);
    if (!svc.container) {
      applyOtelExporterEnv(env, name, this.deps.otlpEndpoint());
    }
    return { env, workDir };
  }

  async resolveTaskEnvironment(
    name: string,
    serviceCfg: ServiceConfig,
    clientEnv: Record<string, string>,
  ): Promise<{ env: Record<string, string>; workDir: string }> {
    const cfg = this.deps.cfg();
    const userEmail = this.deps.userEmail();
    const env = await resolveEnvironment(cfg.repoRoot, {
      service: `task:${name}`,
      profile: this.profile,
      serviceCfg,
      profileEnv: this.profileEnv,
      assignedPorts: {},
      runtime: runtimeForService(`task:${name}`, "127.0.0.1", {}, "", cfg.project.name, userEmail),
      userEmail,
      cfg,
      http: this.httpValues(cfg),
      clientEnv,
      fetchSecret: secretManagerFetcher(async () => (await this.deps.tokens.get("user", "", [])).accessToken),
      pluginSources: this.deps.environmentSources(),
    });
    const workDir = serviceCfg.working_dir && !isAbsolute(serviceCfg.working_dir)
      ? join(cfg.repoRoot, serviceCfg.working_dir)
      : serviceCfg.working_dir;
    return { env: envList(env), workDir };
  }

  private httpValues(cfg: DevctlConfig): HttpValueMap {
    const out: HttpValueMap = {};
    const recipes = this.deps.recipes;
    if (!recipes) {
      return out;
    }
    for (const name of Object.keys(cfg.http)) {
      const snap = recipes.snapshot(name);
      if (snap) {
        out[name] = snap.values;
      }
    }
    return out;
  }

  private httpExposeUrls(cfg: DevctlConfig): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, recipe] of Object.entries(cfg.http)) {
      if (recipe.expose.enabled) {
        out[httpRecipeEnvUrlKey(name)] = `http://${recipe.expose.host || `${name}.local`}:${cfg.proxy.listen.port}`;
      }
    }
    return out;
  }
}
