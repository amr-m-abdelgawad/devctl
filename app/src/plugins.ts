import { pathToFileURL } from "node:url";
import { type HealthCheckConfig } from "./config/index.ts";
import { type EnvironmentSource } from "./environment.ts";
import { type IdentityProvider } from "./identity.ts";
import { defaultLogParser, type LogParser } from "./logs.ts";
import { injectIdentityHeaders, type ProxyMiddleware } from "./proxy.ts";
import { type TokenProvider, googleTokenProviders } from "./token.ts";
import { userIdentityProvider, serviceAccountIdentityProvider } from "./identity.ts";

export type PluginModule = {
  tokenProviders?: TokenProvider[];
  identityProviders?: IdentityProvider[];
  environmentSources?: EnvironmentSource[];
  healthChecks?: HealthCheckPlugin[];
  logParsers?: LogParser[];
  proxyMiddleware?: ProxyMiddleware[];
};

export type HealthCheckPlugin = {
  name: string;
  check: (cfg: HealthCheckConfig, ctx: { pid: number; ports: Record<string, number>; workDir: string; env: Record<string, string> }) => Promise<{ status: string; message: string }>;
};

export class Registry {
  readonly tokenProviders: TokenProvider[] = [];
  readonly identityProviders: IdentityProvider[] = [];
  readonly environmentSources: EnvironmentSource[] = [];
  readonly healthChecks: HealthCheckPlugin[] = [];
  readonly logParsers: LogParser[] = [];
  readonly proxyMiddleware: ProxyMiddleware[] = [];

  registerBuiltins(): void {
    this.tokenProviders.push(...googleTokenProviders());
    this.identityProviders.push(userIdentityProvider(), serviceAccountIdentityProvider());
    this.logParsers.push(defaultLogParser());
    this.proxyMiddleware.push(identityInjectMiddleware());
  }

  register(mod: PluginModule): void {
    pushAll(this.tokenProviders, mod.tokenProviders);
    pushAll(this.identityProviders, mod.identityProviders);
    pushAll(this.environmentSources, mod.environmentSources);
    pushAll(this.healthChecks, mod.healthChecks);
    pushAll(this.logParsers, mod.logParsers);
    pushAll(this.proxyMiddleware, mod.proxyMiddleware);
  }
}

export async function loadPluginPaths(paths: string[]): Promise<Registry> {
  const registry = new Registry();
  registry.registerBuiltins();
  for (const path of paths) {
    if (path.trim() === "") {
      continue;
    }
    const href = path.startsWith("file:") ? path : pathToFileURL(path).href;
    const mod = (await import(href)) as PluginModule;
    registry.register(mod);
  }
  return registry;
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
