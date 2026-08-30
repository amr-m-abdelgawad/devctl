import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { resolveEnvMap, type DevctlConfig, type ServiceConfig } from "./config/index.ts";
import { KindConfiguration, newError, wrapError } from "./errors.ts";
import { credentialsDir } from "./storage.ts";

export type EnvRequest = {
  service: string;
  profile: string;
  serviceCfg: ServiceConfig;
  profileEnv: Record<string, string>;
  assignedPorts: Record<string, number>;
  runtime: Record<string, string>;
  cfg?: DevctlConfig;
  sourceValues?: Partial<Record<string, Record<string, string>>>;
};

export type EnvSourceContext = {
  repoRoot: string;
  profile: string;
  service: string;
  serviceCfg: ServiceConfig;
  workDir: string;
  cfg?: DevctlConfig;
};

export type EnvironmentSource = {
  name: string;
  load: (ctx: EnvSourceContext) => Record<string, string> | Promise<Record<string, string>>;
};

export const ENV_SOURCE_ORDER = ["process", "profile", "dotenv", "generated", "keychain", "secret_manager", "defaults", "vars", "runtime"] as const;

export type EnvSourceName = (typeof ENV_SOURCE_ORDER)[number];

const SECRET_MANAGER_PATTERN = /^projects\/[^/]+\/secrets\/[^/]+(?:\/versions\/[^/]+)?$/;
const ALWAYS_ON_SOURCES: readonly EnvSourceName[] = ["process", "defaults", "vars", "runtime"];

export function processSource(): EnvironmentSource {
  return {
    name: "process",
    load: () => osEnviron(),
  };
}

export function dotenvSource(): EnvironmentSource {
  return {
    name: "dotenv",
    load: (ctx) => {
      const out = loadDotenvFamily(ctx.repoRoot, ctx.profile);
      if (ctx.workDir !== "") {
        Object.assign(out, loadDotenvFamily(ctx.workDir, ctx.profile));
      }
      return out;
    },
  };
}

export function generatedSource(): EnvironmentSource {
  return {
    name: "generated",
    load: () => ({}),
  };
}

export function keychainSource(): EnvironmentSource {
  return {
    name: "keychain",
    load: (ctx) => loadKeychainEnv(ctx),
  };
}

export function secretManagerSource(fetchSecret?: (name: string) => string): EnvironmentSource {
  return {
    name: "secret_manager",
    load: (ctx) => loadSecretManagerEnv(ctx, fetchSecret),
  };
}

export function sourceOrder(cfg?: DevctlConfig): EnvSourceName[] {
  const configured = cfg?.environment.sources ?? [];
  if (configured.length === 0) {
    return [...ENV_SOURCE_ORDER];
  }
  const wanted = new Set<string>([...ALWAYS_ON_SOURCES, ...configured]);
  return ENV_SOURCE_ORDER.filter((name) => wanted.has(name));
}

export function resolveEnvironment(repoRoot: string, req: EnvRequest): Record<string, string> {
  const out: Record<string, string> = {};
  let workDir = req.serviceCfg.working_dir;
  if (workDir !== "" && !isAbsolute(workDir)) {
    workDir = join(repoRoot, workDir);
  }
  const ctx: EnvSourceContext = {
    repoRoot,
    profile: req.profile,
    service: req.service,
    serviceCfg: req.serviceCfg,
    workDir,
    cfg: req.cfg,
  };
  const assignedAll = collectAssigned(req);
  const layers: Record<string, Record<string, string>> = {
    process: osEnviron(),
    profile: resolveMaybe(req.profileEnv, req.cfg, assignedAll),
    dotenv: resolveMaybe(dotenvSource().load(ctx) as Record<string, string>, req.cfg, assignedAll),
    generated: {},
    keychain: req.sourceValues?.keychain ?? loadKeychainEnv(ctx),
    secret_manager: req.sourceValues?.secret_manager ?? loadSecretManagerEnv(ctx),
    defaults: resolveMaybe(req.serviceCfg.environment.defaults, req.cfg, assignedAll),
    vars: resolveMaybe(req.serviceCfg.environment.vars, req.cfg, assignedAll),
    runtime: req.runtime,
  };
  for (const name of sourceOrder(req.cfg)) {
    Object.assign(out, layers[name] ?? {});
  }
  for (const key of req.serviceCfg.environment.required) {
    if ((out[key] ?? "").trim() === "") {
      throw newError(KindConfiguration, `service ${req.service} missing required environment variable ${key}`);
    }
  }
  return out;
}

function collectAssigned(req: EnvRequest): Record<string, Record<string, number>> {
  const assignedAll: Record<string, Record<string, number>> = {};
  if (req.cfg) {
    for (const [name, svc] of Object.entries(req.cfg.services)) {
      const ports: Record<string, number> = {};
      for (const p of svc.ports) {
        if (!p.auto) {
          ports[p.name] = p.value;
        }
      }
      assignedAll[name] = ports;
    }
  }
  if (req.assignedPorts) {
    assignedAll[req.service] = req.assignedPorts;
  }
  return assignedAll;
}

function resolveMaybe(
  input: Record<string, string>,
  cfg: DevctlConfig | undefined,
  assigned: Record<string, Record<string, number>>,
): Record<string, string> {
  if (!cfg || Object.keys(input).length === 0) {
    return input;
  }
  return resolveEnvMap(input, cfg, assigned);
}

function loadKeychainEnv(ctx: EnvSourceContext): Record<string, string> {
  const wanted = ctx.cfg?.environment.sources ?? [];
  if (wanted.length > 0 && !wanted.includes("keychain")) {
    return {};
  }
  const out: Record<string, string> = {};
  const keys = new Set<string>([
    ...Object.keys(ctx.serviceCfg.environment.defaults),
    ...Object.keys(ctx.serviceCfg.environment.vars),
    ...ctx.serviceCfg.environment.required,
  ]);
  for (const key of keys) {
    const path = join(credentialsDir(), "env", key);
    if (!existsSync(path)) {
      continue;
    }
    try {
      out[key] = readFileSync(path, "utf8").replace(/\n$/, "");
    } catch (err) {
      throw wrapError(KindConfiguration, `unable to read keychain env ${key}`, err);
    }
  }
  return out;
}

function loadSecretManagerEnv(ctx: EnvSourceContext, fetchSecret?: (name: string) => string): Record<string, string> {
  const wanted = ctx.cfg?.environment.sources ?? [];
  if (!wanted.includes("secret_manager")) {
    return {};
  }
  const secrets = ctx.cfg?.environment.secrets ?? {};
  const out: Record<string, string> = {};
  for (const [key, resource] of Object.entries(secrets)) {
    if (!SECRET_MANAGER_PATTERN.test(resource)) {
      throw newError(KindConfiguration, `environment.secrets.${key} is not a Secret Manager resource`);
    }
    if (!fetchSecret) {
      throw newError(
        KindConfiguration,
        `environment source secret_manager is not configured — set credentials or remove it from environment.sources`,
      );
    }
    out[key] = fetchSecret(resource);
  }
  return out;
}

function loadDotenvFamily(dir: string, profile: string): Record<string, string> {
  const out: Record<string, string> = {};
  const names = [".env", ".env.local", ".env.development"];
  if (profile !== "") {
    names.push(`.env.${profile}`);
  }
  for (const name of names) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = parseDotenv(readFileSync(path));
      Object.assign(out, parsed);
    } catch (err) {
      throw wrapError(KindConfiguration, `unable to read ${path}`, err);
    }
  }
  return out;
}

function osEnviron(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function runtimeForService(
  name: string,
  host: string,
  ports: Record<string, number>,
  proxyURL: string,
  environment: string,
): Record<string, string> {
  const out: Record<string, string> = {
    DEVCTL_SERVICE_NAME: name,
    DEVCTL_ENVIRONMENT: environment,
    SERVICE_HOST: host,
  };
  if (proxyURL !== "") {
    out.DEVCTL_PROXY_URL = proxyURL;
  }
  if (ports.http !== undefined) {
    out.SERVICE_PORT = String(ports.http);
  } else {
    const first = Object.values(ports)[0];
    if (first !== undefined) {
      out.SERVICE_PORT = String(first);
    }
  }
  for (const [portName, port] of Object.entries(ports)) {
    out[`${portName.toUpperCase()}_PORT`] = String(port);
  }
  return out;
}

export function envList(env: Record<string, string>): Record<string, string> {
  return { ...process.env, ...env } as Record<string, string>;
}
