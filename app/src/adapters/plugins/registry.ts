import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { type HealthCheckConfig } from "../config/index.ts";
import { type EnvironmentSource } from "../environment/environment.ts";
import { type IdentityProvider } from "../../domain/identity/identity.ts";
import { defaultLogParser, type LogParser } from "../storage/logs.ts";
import { injectIdentityHeaders, type ProxyMiddleware } from "../proxy/proxy.ts";
import { type TokenProvider, googleTokenProviders } from "../google/token.ts";
import { userIdentityProvider, serviceAccountIdentityProvider } from "../../domain/identity/identity.ts";

export type PluginModule = {
  sdkVersion?: number;
  tokenProviders?: TokenProvider[];
  identityProviders?: IdentityProvider[];
  environmentSources?: EnvironmentSource[];
  healthChecks?: HealthCheckPlugin[];
  logParsers?: LogParser[];
  proxyMiddleware?: ProxyMiddleware[];
};

export const PLUGIN_SDK_VERSION = 1;
export type PluginLoadError = { path: string; message: string };

export type HealthCheckPlugin = {
  name: string;
  check: (cfg: HealthCheckConfig, ctx: { pid: number; ports: Record<string, number>; workDir: string; env: Record<string, string> }) => Promise<{ status: string; message: string }>;
};

export class Registry {
  readonly tokenProviders: TokenProvider[] = [];
  readonly identityProviders: IdentityProvider[] = [];
  readonly pluginIdentityProviders: IdentityProvider[] = [];
  readonly environmentSources: EnvironmentSource[] = [];
  readonly healthChecks: HealthCheckPlugin[] = [];
  readonly logParsers: LogParser[] = [];
  readonly proxyMiddleware: ProxyMiddleware[] = [];
  readonly loadErrors: PluginLoadError[] = [];

  registerBuiltins(): void {
    this.tokenProviders.push(...googleTokenProviders());
    this.identityProviders.push(userIdentityProvider(), serviceAccountIdentityProvider());
    this.logParsers.push(defaultLogParser());
    this.proxyMiddleware.push(identityInjectMiddleware());
  }

  register(mod: PluginModule): void {
    validatePluginModule(mod);
    pushAll(this.tokenProviders, mod.tokenProviders);
    pushAll(this.identityProviders, mod.identityProviders);
    pushAll(this.pluginIdentityProviders, mod.identityProviders);
    pushAll(this.environmentSources, mod.environmentSources);
    pushAll(this.healthChecks, mod.healthChecks);
    pushAll(this.logParsers, mod.logParsers);
    pushAll(this.proxyMiddleware, mod.proxyMiddleware);
  }
}

export async function loadPluginPaths(paths: string[], baseDir = process.cwd()): Promise<Registry> {
  const registry = new Registry();
  registry.registerBuiltins();
  for (const path of paths) {
    if (path.trim() === "") {
      continue;
    }
    try {
      const resolved = path.startsWith("file:") ? path : (isAbsolute(path) ? path : resolve(baseDir, path));
      const href = resolved.startsWith("file:") ? resolved : pathToFileURL(resolved).href;
      const mod = (await import(href)) as PluginModule;
      if (mod.sdkVersion !== PLUGIN_SDK_VERSION) throw new Error(`plugin SDK version ${String(mod.sdkVersion ?? "missing")} is incompatible; expected ${PLUGIN_SDK_VERSION}`);
      registry.register(mod);
    } catch (err) {
      registry.loadErrors.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return registry;
}

function validatePluginModule(mod: PluginModule): void {
  if (!mod || typeof mod !== "object") throw new Error("plugin module must export an object");
  validateExtensions("tokenProviders", mod.tokenProviders, ["fetch"]);
  validateExtensions("identityProviders", mod.identityProviders, ["accepts", "resolve"]);
  validateExtensions("environmentSources", mod.environmentSources, ["load"]);
  validateExtensions("healthChecks", mod.healthChecks, ["check"]);
  validateExtensions("logParsers", mod.logParsers, ["parse"]);
  validateExtensions("proxyMiddleware", mod.proxyMiddleware, ["apply"]);
}

function validateExtensions(name: string, entries: unknown, methods: string[]): void {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw new Error(`${name} must be an array`);
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || typeof (entry as { name?: unknown }).name !== "string" || (entry as { name: string }).name === "") throw new Error(`${name}[${index}] must have a name`);
    for (const method of methods) if (typeof (entry as Record<string, unknown>)[method] !== "function") throw new Error(`${name}[${index}].${method} must be a function`);
  }
}

function identityInjectMiddleware(): ProxyMiddleware {
  return {
    name: "identity_inject",
    apply: async (ctx) => {
      await injectIdentityHeaders(ctx.route, ctx.headers, ctx.tokens);
    },
  };
}

function pushAll<T>(dest: T[], extra?: T[]): void {
  if (!extra) {
    return;
  }
  dest.push(...extra);
}
