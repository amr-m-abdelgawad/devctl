import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { ConfigDirName } from "../../domain/config/paths.ts";
import { resolveEnvMap, type DevctlConfig, type EnvConfig, type HelmEnvConfig, type ServiceConfig, type TerraformEnvConfig } from "../config/index.ts";
import type { HttpValueMap } from "../config/refs.ts";
import {
  DevctlError,
  KindAuthentication,
  KindAuthorization,
  KindConfiguration,
  KindGeneral,
  KindToken,
  newError,
  wrapError,
} from "../../shared/errors.ts";
import { credentialsDir, homeDir } from "../storage/storage.ts";
import { loadTerraformEnvironment } from "./terraform.ts";
import { loadHelmEnvironment } from "./helm.ts";

export type EnvRequest = {
  service: string;
  profile: string;
  serviceCfg: ServiceConfig;
  profileEnv: Record<string, string>;
  assignedPorts: Record<string, number>;
  runtime: Record<string, string>;
  // The detected developer identity, resolved for ${identity.user} references
  // in configured environment values. Empty when no identity is detected.
  userEmail?: string;
  cfg?: DevctlConfig;
  sourceValues?: Partial<Record<string, Record<string, string>>>;
  fetchSecret?: (resource: string) => string | Promise<string>;
  pluginSources?: EnvironmentSource[];
  // The OS environment of whichever client (CLI/TUI) most recently issued a
  // start/restart for this service, captured at the daemon's RPC boundary —
  // never the daemon's own process.env, which is a stale snapshot fixed at
  // whenever the daemon itself was first spawned. Falls back to the
  // daemon's own environment (osEnviron()) when no client has ever supplied
  // one for this service, e.g. an MCP-initiated start or a session-recovered
  // process.
  clientEnv?: Record<string, string>;
  // Per-service keys from `profiles.<name>.service_environment.<svc>`.
  // Applied after service vars so a profile can retarget AUTH_URL at a
  // deployed backend. Empty when the launch profile has no entry.
  profileServiceEnv?: EnvConfig;
  http?: HttpValueMap;
  // Containers should not copy the caller's entire shell into inspectable
  // container metadata. All explicitly configured environment layers remain.
  includeProcess?: boolean;
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

export const ENV_SOURCE_ORDER = ["process", "profile", "dotenv", "secrets_env", "generated", "keychain", "sops", "secret_manager", "defaults", "terraform", "helm", "vars", "profile_service", "runtime"] as const;

export type EnvSourceName = (typeof ENV_SOURCE_ORDER)[number];

const SECRET_MANAGER_PATTERN = /^projects\/[^/]+\/secrets\/[^/]+(?:\/versions\/[^/]+)?$/;
const ALWAYS_ON_SOURCES: readonly EnvSourceName[] = ["process", "secrets_env", "defaults", "terraform", "helm", "vars", "profile_service", "runtime"];

function terraformSource(req: EnvRequest): { prefix: string; spec: TerraformEnvConfig | undefined } {
  const overlay = req.profileServiceEnv?.terraform;
  if (overlay && (overlay.path !== "" || overlay.invalid)) {
    return { prefix: `profiles.${req.profile}.service_environment.${req.service}.terraform`, spec: overlay };
  }
  return { prefix: `services.${req.service}.environment.terraform`, spec: req.serviceCfg.environment.terraform };
}

function helmSource(req: EnvRequest): { prefix: string; spec: HelmEnvConfig | undefined } {
  const overlay = req.profileServiceEnv?.helm;
  if (overlay && (overlay.path !== "" || overlay.invalid)) {
    return { prefix: `profiles.${req.profile}.service_environment.${req.service}.helm`, spec: overlay };
  }
  return { prefix: `services.${req.service}.environment.helm`, spec: req.serviceCfg.environment.helm };
}

function dotenvSource(): EnvironmentSource {
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

// Returns the source names to apply, in precedence order (later wins).
// Plugin-registered sources (any configured name outside ENV_SOURCE_ORDER)
// are spliced in right before "defaults" — after the external/credential
// sources but still overridable by a service's own defaults/vars/runtime.
export function sourceOrder(cfg?: DevctlConfig): string[] {
  const configured = cfg?.environment.sources ?? [];
  if (configured.length === 0) {
    return [...ENV_SOURCE_ORDER];
  }
  const wanted = new Set<string>([...ALWAYS_ON_SOURCES, ...configured]);
  // Secret Manager wins when reachable; dotenv is the local fallback when
  // ADC or IAM is missing, even if the repo only listed secret_manager.
  if (wanted.has("secret_manager")) {
    wanted.add("dotenv");
  }
  const builtin = new Set<string>(ENV_SOURCE_ORDER);
  const extra = configured.filter((name) => !builtin.has(name));
  const order: string[] = [];
  for (const name of ENV_SOURCE_ORDER) {
    if (name === "defaults") {
      order.push(...extra);
    }
    if (wanted.has(name)) {
      order.push(name);
    }
  }
  return order;
}

export async function resolveEnvironment(repoRoot: string, req: EnvRequest): Promise<Record<string, string>> {
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
  const userEmail = req.userEmail ?? "";
  const processLayer = req.includeProcess === false ? {} : (req.clientEnv ?? osEnviron());
  // `${env.NAME}` in YAML interpolates from the caller's env + secrets.env even
  // when the process layer is omitted (containers), so a named secret can land
  // in a declared key without copying the whole shell into the container.
  const interpolationEnv = envWithSecrets(req.clientEnv ?? osEnviron(), repoRoot);
  const profileLayer = resolveMaybe(req.profileEnv, req.cfg, assignedAll, userEmail, req.http, interpolationEnv);
  const terraform = terraformSource(req);
  const helm = helmSource(req);
  const layers: Record<string, Record<string, string>> = {
    process: processLayer,
    profile: profileLayer,
    dotenv: resolveMaybe(await dotenvSource().load(ctx), req.cfg, assignedAll, userEmail, req.http, interpolationEnv),
    secrets_env: secretsEnvLayer(repoRoot, processLayer, profileLayer),
    generated: {},
    keychain: req.sourceValues?.keychain ?? loadKeychainEnv(ctx),
    sops: req.sourceValues?.sops ?? {},
    secret_manager: req.sourceValues?.secret_manager ?? (await loadSecretManagerEnv(ctx, req.fetchSecret)),
    defaults: resolveMaybe(req.serviceCfg.environment.defaults, req.cfg, assignedAll, userEmail, req.http, interpolationEnv),
    // Terraform literals are already concrete. Do not expand ${} in them:
    // $${ in HCL is a literal ${...}, not a devctl reference.
    terraform: loadTerraformEnvironment(repoRoot, terraform.prefix, terraform.spec),
    helm: loadHelmEnvironment(repoRoot, helm.prefix, helm.spec),
    vars: resolveMaybe(req.serviceCfg.environment.vars, req.cfg, assignedAll, userEmail, req.http, interpolationEnv),
    profile_service: resolveMaybe(flattenEnvConfig(req.profileServiceEnv), req.cfg, assignedAll, userEmail, req.http, interpolationEnv),
    runtime: req.runtime,
  };
  for (const name of sourceOrder(req.cfg)) {
    if (layers[name] !== undefined) {
      Object.assign(out, layers[name]);
      continue;
    }
    const plugin = req.pluginSources?.find((source) => source.name === name);
    if (plugin) {
      Object.assign(out, resolveMaybe(await plugin.load(ctx), req.cfg, assignedAll, userEmail, req.http, interpolationEnv));
    }
  }
  const required = [...req.serviceCfg.environment.required, ...(req.profileServiceEnv?.required ?? [])];
  for (const key of required) {
    if ((out[key] ?? "").trim() === "") {
      throw newError(KindConfiguration, `service ${req.service} missing required environment variable ${key}`);
    }
  }
  return out;
}

const SECRETS_ENV_FILE = "secrets.env";

// User ~/.devctl/secrets.env first (weaker), then repo .devctl/secrets.env.
// Process env is merged later by callers so it still wins.
export function loadSecretsEnv(repoRoot?: string): Record<string, string> {
  const out: Record<string, string> = {};
  Object.assign(out, readDotenvFile(join(homeDir(), SECRETS_ENV_FILE)));
  const root = repoRoot && repoRoot !== "" ? repoRoot : discoverRepoRoot();
  if (root) {
    Object.assign(out, readDotenvFile(join(root, ConfigDirName, SECRETS_ENV_FILE)));
  }
  return out;
}

export function envWithSecrets(env: Record<string, string | undefined>, repoRoot?: string): Record<string, string | undefined> {
  return { ...loadSecretsEnv(repoRoot), ...env };
}

function secretsEnvLayer(repoRoot: string, processLayer: Record<string, string>, profileLayer: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadSecretsEnv(repoRoot))) {
    if (processLayer[key] !== undefined || profileLayer[key] !== undefined) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function discoverRepoRoot(start = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ConfigDirName, "config.yaml")) || existsSync(join(dir, ConfigDirName, SECRETS_ENV_FILE))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function readDotenvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return parseDotenv(readFileSync(path));
  } catch (err) {
    throw wrapError(KindConfiguration, `unable to read ${path}`, err);
  }
}

function flattenEnvConfig(env?: EnvConfig): Record<string, string> {
  if (!env) {
    return {};
  }
  return { ...env.defaults, ...env.vars };
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
  userEmail = "",
  http?: HttpValueMap,
  processEnv?: Record<string, string | undefined>,
): Record<string, string> {
  if (!cfg || Object.keys(input).length === 0) {
    return input;
  }
  return resolveEnvMap(input, cfg, assigned, userEmail, { http, processEnv });
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

async function loadSecretManagerEnv(ctx: EnvSourceContext, fetchSecret?: (name: string) => string | Promise<string>): Promise<Record<string, string>> {
  const wanted = ctx.cfg?.environment.sources ?? [];
  if (!wanted.includes("secret_manager")) {
    return {};
  }
  const secrets = ctx.cfg?.environment.secrets ?? {};
  for (const [key, resource] of Object.entries(secrets)) {
    if (!SECRET_MANAGER_PATTERN.test(resource)) {
      throw newError(KindConfiguration, `environment.secrets.${key} is not a Secret Manager resource`);
    }
  }
  if (!fetchSecret) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, resource] of Object.entries(secrets)) {
    const value = await readSecretManagerValue(fetchSecret, key, resource);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

async function readSecretManagerValue(
  fetchSecret: (name: string) => string | Promise<string>,
  key: string,
  resource: string,
): Promise<string | undefined> {
  try {
    return await fetchSecret(resource);
  } catch (err) {
    if (isSecretManagerAccessFailure(err)) {
      return undefined;
    }
    throw wrapError(KindConfiguration, `unable to read secret manager env ${key}`, err);
  }
}

function isSecretManagerAccessFailure(err: unknown): boolean {
  if (!(err instanceof DevctlError)) {
    return true;
  }
  return err.kind === KindAuthentication || err.kind === KindAuthorization || err.kind === KindToken || err.kind === KindGeneral;
}

function loadDotenvFamily(dir: string, profile: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Later entries win. .env.local is the developer's personal, gitignored
  // override and must outrank a checked-in .env.development; the active
  // devctl profile is the most specific selection for this run, so its own
  // file wins over everything else in the family.
  const names = [".env", ".env.development", ".env.local"];
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

export function osEnviron(): Record<string, string> {
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
  userEmail = "",
): Record<string, string> {
  const out: Record<string, string> = {
    DEVCTL_SERVICE_NAME: name,
    DEVCTL_ENVIRONMENT: environment,
    SERVICE_HOST: host,
  };
  if (proxyURL !== "") {
    out.DEVCTL_PROXY_URL = proxyURL;
  }
  // The developer's own detected Google identity (gcloud/ADC), so a service
  // can key on the person running it without a hardcoded, team-unfriendly
  // value. Empty (omitted) when no identity is detected. Also reachable in
  // config as ${identity.user} for mapping onto a custom-named variable.
  if (userEmail !== "") {
    out.DEVCTL_USER_EMAIL = userEmail;
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
  // resolveEnvironment already includes the calling client's complete OS
  // environment as its lowest-precedence layer. Adding the daemon's own
  // process.env here would reintroduce stale values the client intentionally
  // replaced or omitted, and would make --print-env disagree with execution.
  return { ...env };
}
