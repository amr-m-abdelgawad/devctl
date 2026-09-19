import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  asStringMap,
  decodeCommand,
  decodeDependencies,
  decodeContainer,
  decodePorts,
  decodeProfile,
  decodeRoute,
  decodeEnv,
  decodeService,
  decodeServiceLogMultiline,
  decodeTask,
  decodeServiceProxy,
  decodeExpose,
  decodeHttpRecipe,
  isRecord,
  presentKeys,
} from "./decode.ts";
import { overlayEnv } from "../../domain/service/environments.ts";
import { resolveUserPath } from "../storage/storage.ts";
import {
  emptyService,
  emptyEnv,
  emptyRouteAuth,
  namedPort,
  watchDebounceMs,
  type DevctlConfig,
  type ConfigProvenance,
  type EnvConfig,
  type HealthCheckConfig,
  type IdentityConfig,
  type ProfileConfig,
  type ProxyConfig,
  type RestartConfig,
  type RouteAuthConfig,
  type RouteConfig,
  type ServiceConfig,
  type ServiceLogConfig,
  type ServiceLogMultilineConfig,
  type StartupConfig,
  type TaskConfig,
  type TelemetryConfig,
  type WebConfig,
  type LlmConfig,
  type LlmSourceConfig,
  type HttpRecipeConfig,
} from "../../domain/config/types.ts";

// Field names ever explicitly set, per service or template name, by any
// source that has contributed to it so far (the main file, a modular
// services/*.yaml file, a local overlay). Template inheritance
// (applyTemplates, below) runs after all of those have already merged and
// has no raw YAML node left to check presence against, so it consults this
// instead of guessing from whether the decoded value happens to differ
// from its zero default. Services and templates get separate maps since
// the two share no namespace and could otherwise collide on a name.
export type FieldPresenceMap = Record<string, Set<string>>;

export type ConfigPresence = {
  services: FieldPresenceMap;
  templates: FieldPresenceMap;
  provenance: ConfigProvenance;
};

export function newConfigPresence(): ConfigPresence {
  return { services: {}, templates: {}, provenance: {} };
}

export function recordProvenance(provenance: ConfigProvenance, raw: unknown, source: string, layer: string, prefix = ""): void {
  if (isRecord(raw) && Object.keys(raw).length > 0) {
    for (const [key, value] of Object.entries(raw)) {
      recordProvenance(provenance, value, source, layer, prefix === "" ? key : `${prefix}.${key}`);
    }
    return;
  }
  if (prefix === "") return;
  (provenance[prefix] ??= []).push({ source, layer });
}

// Service fields that are themselves merged field-by-field rather than
// replaced wholesale — so presence needs to be tracked one level deeper
// than just "was this key present" for each of them too.
const NESTED_OBJECT_FIELDS = ["environment", "restart", "startup", "health", "logs", "identity", "container", "watch", "hooks"] as const;

export function recordPresence(map: FieldPresenceMap, name: string, raw: unknown): void {
  const keys = presentKeys(raw);
  if (isRecord(raw)) {
    for (const field of NESTED_OBJECT_FIELDS) {
      const nested = (raw as Record<string, unknown>)[field];
      if (isRecord(nested)) {
        for (const key of Object.keys(nested)) {
          keys.add(`${field}.${key}`);
          const deeper = nested[key];
          if (field === "logs" && key === "multiline" && isRecord(deeper)) {
            for (const inner of Object.keys(deeper)) {
              keys.add(`${field}.${key}.${inner}`);
            }
          }
        }
      }
    }
  }
  const existing = map[name];
  map[name] = existing ? new Set([...existing, ...keys]) : keys;
}

// Applies one raw config root (the main file, or a local overlay) onto an
// existing DevctlConfig, field by field, touching only what the raw node
// actually declares — an absent key leaves whatever's already in cfg
// untouched, including an explicit false/0/[] that a base or earlier
// overlay already set. The first call (decoding the main file into a fresh
// defaultConfig()) behaves exactly as a plain decode would, since nothing
// is "existing" yet for services/profiles/templates to merge against.
export function applyRoot(
  cfg: DevctlConfig,
  raw: Record<string, unknown>,
  presence: ConfigPresence = newConfigPresence(),
  origin: { source: string; layer: string } = { source: "unknown", layer: "unknown" },
): void {
  recordProvenance(presence.provenance, raw, origin.source, origin.layer);
  if (raw.version !== undefined) {
    cfg.version = asNumber(raw.version);
  }
  if (isRecord(raw.project) && raw.project.name !== undefined) {
    cfg.project.name = asString(raw.project.name);
  }
  if (isRecord(raw.google)) {
    if (raw.google.project_id !== undefined) {
      cfg.google.project_id = asString(raw.google.project_id);
    }
    if (raw.google.region !== undefined) {
      cfg.google.region = asString(raw.google.region);
    }
  }
  if (isRecord(raw.profiles)) {
    for (const [name, value] of Object.entries(raw.profiles)) {
      const existing = cfg.profiles[name];
      cfg.profiles[name] = existing ? mergeProfile(existing, value) : decodeProfile(value);
    }
  }
  if (isRecord(raw.templates)) {
    for (const [name, value] of Object.entries(raw.templates)) {
      const existing = cfg.templates[name];
      cfg.templates[name] = existing ? mergeService(existing, value) : decodeService(value);
      recordPresence(presence.templates, name, value);
    }
  }
  if (isRecord(raw.services)) {
    for (const [name, value] of Object.entries(raw.services)) {
      const existing = cfg.services[name];
      cfg.services[name] = existing ? mergeService(existing, value) : decodeService(value);
      recordPresence(presence.services, name, value);
    }
  }
  if (isRecord(raw.tasks)) {
    for (const [name, value] of Object.entries(raw.tasks)) cfg.tasks[name] = cfg.tasks[name] ? mergeTask(cfg.tasks[name]!, value) : decodeTask(value);
  }
  if (isRecord(raw.http)) {
    for (const [name, value] of Object.entries(raw.http)) {
      const existing = cfg.http[name];
      cfg.http[name] = existing ? mergeHttpRecipe(existing, value) : decodeHttpRecipe(value);
    }
  }
  if (isRecord(raw.proxy)) {
    applyProxy(cfg.proxy, raw.proxy);
  }
  if (isRecord(raw.logs)) {
    if (raw.logs.max_memory_events !== undefined) {
      cfg.logs.max_memory_events = asNumber(raw.logs.max_memory_events);
    }
    if (isRecord(raw.logs.persistence)) {
      const persistence = raw.logs.persistence;
      if (persistence.enabled !== undefined) {
        cfg.logs.persistence.enabled = asBoolean(persistence.enabled);
      }
      if (persistence.directory !== undefined) {
        cfg.logs.persistence.directory = asString(persistence.directory);
      }
      if (persistence.retention_days !== undefined) {
        cfg.logs.persistence.retention_days = asNumber(persistence.retention_days);
      }
      if (persistence.max_session_logs !== undefined) {
        cfg.logs.persistence.max_session_logs = asNumber(persistence.max_session_logs);
      }
    }
  }
  if (isRecord(raw.auth) && raw.auth.refresh_threshold_seconds !== undefined) {
    cfg.auth.refresh_threshold_seconds = asNumber(raw.auth.refresh_threshold_seconds);
  }
  if (isRecord(raw.shutdown)) {
    if (raw.shutdown.stop_services_on_exit !== undefined) {
      cfg.shutdown.stop_services_on_exit = asBoolean(raw.shutdown.stop_services_on_exit);
    }
    if (raw.shutdown.grace_seconds !== undefined) {
      cfg.shutdown.grace_seconds = asNumber(raw.shutdown.grace_seconds);
    }
  }
  if (isRecord(raw.ui)) {
    if (raw.ui.theme !== undefined) {
      cfg.ui.theme = asString(raw.ui.theme);
    }
    if (raw.ui.keymap !== undefined) {
      cfg.ui.keymap = asStringMap(raw.ui.keymap);
    }
  }
  if (isRecord(raw.secrets)) {
    if (raw.secrets.extra_markers !== undefined) {
      cfg.secrets.extra_markers = asStringArray(raw.secrets.extra_markers);
    }
    if (raw.secrets.extra_patterns !== undefined) {
      cfg.secrets.extra_patterns = asStringArray(raw.secrets.extra_patterns);
    }
  }
  if (isRecord(raw.doctor) && Array.isArray(raw.doctor.tools)) {
    cfg.doctor.tools = raw.doctor.tools.filter(isRecord).map((tool) => ({
      name: asString(tool.name),
      command: asString(tool.command),
    }));
  }
  if (Array.isArray(raw.plugins)) {
    cfg.plugins = raw.plugins.filter(isRecord).map((plugin) => ({ path: asString(plugin.path) })).filter((plugin) => plugin.path !== "");
  }
  if (isRecord(raw.environment)) {
    if (Array.isArray(raw.environment.sources)) {
      cfg.environment.sources = asStringArray(raw.environment.sources);
    }
    if (isRecord(raw.environment.secrets)) {
      cfg.environment.secrets = { ...cfg.environment.secrets, ...asStringMap(raw.environment.secrets) };
    }
  }
  if (isRecord(raw.telemetry)) {
    applyTelemetry(cfg.telemetry, raw.telemetry);
  }
  if (isRecord(raw.web)) {
    applyWeb(cfg.web, raw.web);
  }
  if (isRecord(raw.llm)) {
    applyLlm(cfg.llm, raw.llm);
  }
}

export function applyTelemetry(telemetry: TelemetryConfig, raw: Record<string, unknown>): void {
  if (!isRecord(raw.otlp)) {
    return;
  }
  const otlp = raw.otlp;
  if (otlp.enabled !== undefined) {
    telemetry.otlp.enabled = asBoolean(otlp.enabled);
  }
  if (isRecord(otlp.listen)) {
    if (otlp.listen.host !== undefined) {
      telemetry.otlp.listen.host = asString(otlp.listen.host);
    }
    if (otlp.listen.port !== undefined) {
      telemetry.otlp.listen.port = asNumber(otlp.listen.port);
    }
  }
}

export function applyWeb(web: WebConfig, raw: Record<string, unknown>): void {
  if (raw.enabled !== undefined) {
    web.enabled = asBoolean(raw.enabled);
  }
  if (isRecord(raw.listen)) {
    if (raw.listen.host !== undefined) {
      web.listen.host = asString(raw.listen.host);
    }
    if (raw.listen.port !== undefined) {
      web.listen.port = asNumber(raw.listen.port);
    }
  }
}

export function applyLlm(llm: LlmConfig, raw: Record<string, unknown>): void {
  if (raw.enabled !== undefined) {
    llm.enabled = asBoolean(raw.enabled);
  }
  if (!Array.isArray(raw.sources)) {
    return;
  }
  llm.sources = raw.sources.filter(isRecord).map(decodeLlmSource).filter((source) => source.name !== "" || source.type !== "");
}

function decodeLlmSource(raw: Record<string, unknown>): LlmSourceConfig {
  const auth = isRecord(raw.auth) ? raw.auth : {};
  const via = isRecord(raw.via) ? raw.via : {};
  const capture = isRecord(raw.capture) ? raw.capture : {};
  return {
    name: asString(raw.name),
    type: asString(raw.type),
    service: asString(raw.service),
    port: asString(raw.port),
    endpoint: asString(raw.endpoint),
    path_prefix: asString(raw.path_prefix),
    headers: asStringMap(raw.headers),
    via: { route: asString(via.route), routes: asStringArray(via.routes) },
    management_endpoint: asString(raw.management_endpoint),
    management_service: asString(raw.management_service),
    management_port: asString(raw.management_port),
    auth: {
      type: asString(auth.type),
      token_env: asString(auth.token_env),
      header: asString(auth.header),
    },
    capture: {
      prompts: capture.prompts === undefined ? true : asBoolean(capture.prompts),
      max_bytes: asNumber(capture.max_bytes),
      paths: asStringArray(capture.paths),
    },
    poll_seconds: asNumber(raw.poll_seconds),
  };
}

export function applyProxy(proxy: ProxyConfig, raw: Record<string, unknown>): void {
  if (raw.enabled !== undefined) {
    proxy.enabled = asBoolean(raw.enabled);
  }
  if (raw.gateway !== undefined) {
    proxy.gateway = asBoolean(raw.gateway);
  }
  if (raw.credentials !== undefined) {
    proxy.credentials = asString(raw.credentials);
  }
  if (isRecord(raw.listen)) {
    if (raw.listen.host !== undefined) {
      proxy.listen.host = asString(raw.listen.host);
    }
    if (raw.listen.port !== undefined) {
      proxy.listen.port = asNumber(raw.listen.port);
    }
  }
  if (isRecord(raw.token_endpoint)) {
    const endpoint = raw.token_endpoint;
    if (endpoint.enabled !== undefined) {
      proxy.token_endpoint.enabled = asBoolean(endpoint.enabled);
    }
    if (endpoint.host !== undefined) {
      proxy.token_endpoint.host = asString(endpoint.host);
    }
    if (endpoint.port !== undefined) {
      proxy.token_endpoint.port = asNumber(endpoint.port);
    }
  }
  if (Array.isArray(raw.routes)) {
    proxy.routes = raw.routes.map((route) => decodeRoute(route));
  }
}

function mergeProfile(base: ProfileConfig, raw: unknown): ProfileConfig {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    services: raw.services !== undefined ? asStringArray(raw.services) : base.services,
    environment: raw.environment !== undefined ? { ...base.environment, ...asStringMap(raw.environment) } : base.environment,
    environments: raw.environments !== undefined ? { ...base.environments, ...asStringMap(raw.environments) } : base.environments,
    service_environment: raw.service_environment !== undefined ? mergeEnvironments(base.service_environment, raw.service_environment) : base.service_environment,
  };
}

export function mergeHttpRecipe(base: HttpRecipeConfig, raw: unknown): HttpRecipeConfig {
  if (!isRecord(raw)) {
    return base;
  }
  const decoded = decodeHttpRecipe(raw);
  const present = presentKeys(raw);
  const reqPresent = presentKeys(raw.request);
  const cachePresent = presentKeys(raw.cache);
  const exposePresent = presentKeys(raw.expose);
  return {
    request: {
      method: reqPresent.has("method") ? decoded.request.method : base.request.method,
      url: reqPresent.has("url") ? decoded.request.url : base.request.url,
      headers: reqPresent.has("headers") ? { ...base.request.headers, ...decoded.request.headers } : base.request.headers,
      body: reqPresent.has("body") ? decoded.request.body : base.request.body,
      form: reqPresent.has("form") ? { ...base.request.form, ...decoded.request.form } : base.request.form,
      auth: reqPresent.has("auth") ? decoded.request.auth : base.request.auth,
      timeout_seconds: reqPresent.has("timeout_seconds") ? decoded.request.timeout_seconds : base.request.timeout_seconds,
    },
    outputs: present.has("outputs") ? { ...base.outputs, ...decoded.outputs } : base.outputs,
    cache: {
      jwt: cachePresent.has("jwt") ? decoded.cache.jwt : base.cache.jwt,
      expires_in: cachePresent.has("expires_in") ? decoded.cache.expires_in : base.cache.expires_in,
    },
    expose: {
      enabled: exposePresent.has("enabled") || raw.expose === true || raw.expose === false ? decoded.expose.enabled : base.expose.enabled,
      host: exposePresent.has("host") ? decoded.expose.host : base.expose.host,
      response_headers: exposePresent.has("response_headers") ? { ...base.expose.response_headers, ...decoded.expose.response_headers } : base.expose.response_headers,
      allow_token_body: exposePresent.has("allow_token_body") ? decoded.expose.allow_token_body : base.expose.allow_token_body,
    },
  };
}

function mergeTask(base: TaskConfig, raw: unknown): TaskConfig {
  if (!isRecord(raw)) return base;
  return {
    command: raw.command !== undefined ? decodeCommand(raw.command) : base.command,
    shell: raw.shell !== undefined ? asBoolean(raw.shell) : base.shell,
    working_dir: raw.working_dir !== undefined ? asString(raw.working_dir) : base.working_dir,
    dependencies: raw.dependencies !== undefined ? asStringArray(raw.dependencies) : base.dependencies,
    environment: mergeEnv(base.environment, raw.environment),
  };
}

export function mergeService(base: ServiceConfig, raw: unknown): ServiceConfig {
  if (!isRecord(raw)) {
    return base;
  }
  const present = presentKeys(raw);
  const out: ServiceConfig = {
    ...base,
    environment: mergeEnv(base.environment, raw.environment),
    environments: mergeEnvironments(base.environments, raw.environments),
    default_environment: present.has("default_environment") ? asString(raw.default_environment) : base.default_environment,
    health: mergeHealth(base.health, raw.health),
    identity: mergeIdentity(base.identity, raw.identity),
    logs: mergeServiceLogs(base.logs, raw.logs),
    restart: mergeRestart(base.restart, raw.restart),
    startup: mergeStartup(base.startup, raw.startup),
    container: mergeContainer(base.container, raw.container),
    watch: mergeWatch(base.watch, raw.watch),
    hooks: mergeHooks(base.hooks, raw.hooks),
  };
  if (present.has("extends")) {
    out.extends = asString(raw.extends);
  }
  if (present.has("description")) {
    out.description = asString(raw.description);
  }
  if (present.has("command")) {
    out.command = decodeCommand(raw.command);
  }
  if (present.has("shell")) {
    out.shell = asBoolean(raw.shell);
  }
  if (present.has("working_dir")) {
    out.working_dir = asString(raw.working_dir);
  }
  if (present.has("dependencies")) {
    out.dependencies = decodeDependencies(raw.dependencies);
  }
  if (present.has("ports")) {
    out.ports = decodePorts(raw.ports);
  }
  if (present.has("capabilities")) {
    out.capabilities = asStringArray(raw.capabilities);
  }
  if (present.has("proxy")) {
    out.proxy = decodeServiceProxy(raw.proxy);
  }
  if (present.has("expose")) {
    out.expose = decodeExpose(raw.expose);
  }
  return out;
}

function mergeWatch(base: ServiceConfig["watch"], raw: unknown): ServiceConfig["watch"] {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    enabled: raw.enabled !== undefined ? asBoolean(raw.enabled) : base.enabled,
    paths: raw.paths !== undefined ? asStringArray(raw.paths) : base.paths,
    debounce_ms: raw.debounce_ms !== undefined ? watchDebounceMs(asNumber(raw.debounce_ms)) : base.debounce_ms,
    ignore: raw.ignore !== undefined ? asStringArray(raw.ignore) : base.ignore,
  };
}

function mergeHooks(base: ServiceConfig["hooks"], raw: unknown): ServiceConfig["hooks"] {
  if (!isRecord(raw)) return base;
  return { pre_start: raw.pre_start !== undefined ? decodeCommand(raw.pre_start) : base.pre_start, post_start: raw.post_start !== undefined ? decodeCommand(raw.post_start) : base.post_start };
}

function mergeEnv(base: EnvConfig, raw: unknown): EnvConfig {
  if (!isRecord(raw)) {
    return base;
  }
  const vars = { ...base.vars };
  const defaults = { ...base.defaults };
  let required = base.required;
  for (const [key, item] of Object.entries(raw)) {
    if (key === "required") {
      required = asStringArray(item);
    } else if (key === "defaults") {
      Object.assign(defaults, asStringMap(item));
    } else {
      vars[key] = asString(item);
    }
  }
  return { vars, required, defaults };
}

function mergeEnvironments(base: Record<string, EnvConfig>, raw: unknown): Record<string, EnvConfig> {
  if (!isRecord(raw)) {
    return base;
  }
  const out = { ...base };
  for (const [name, item] of Object.entries(raw)) {
    const prior = Object.hasOwn(base, name) ? base[name] ?? emptyEnv() : emptyEnv();
    out[name] = overlayEnv(prior, decodeEnv(item));
  }
  return out;
}

// health/identity/logs/restart/startup are merged field by field, not
// replaced wholesale, so extending a template (or layering an overlay) to
// tweak one field of a nested section doesn't require restating the rest
// of it. Each helper is a no-op (returns base unchanged) when raw doesn't
// even have the section, so callers can call these unconditionally.
function mergeHealth(base: HealthCheckConfig, raw: unknown): HealthCheckConfig {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    type: raw.type !== undefined ? asString(raw.type) : base.type,
    url: raw.url !== undefined ? asString(raw.url) : base.url,
    address: raw.address !== undefined ? asString(raw.address) : base.address,
    grpc_service: raw.grpc_service !== undefined ? asString(raw.grpc_service) : base.grpc_service,
    command: raw.command !== undefined ? decodeCommand(raw.command) : base.command,
    interval_seconds: raw.interval_seconds !== undefined ? asNumber(raw.interval_seconds) : base.interval_seconds,
    timeout_seconds: raw.timeout_seconds !== undefined ? asNumber(raw.timeout_seconds) : base.timeout_seconds,
    start_period_seconds: raw.start_period_seconds !== undefined ? asNumber(raw.start_period_seconds) : base.start_period_seconds,
    unhealthy_threshold: raw.unhealthy_threshold !== undefined ? asNumber(raw.unhealthy_threshold) : base.unhealthy_threshold,
    healthy_reset_threshold: raw.healthy_reset_threshold !== undefined ? asNumber(raw.healthy_reset_threshold) : base.healthy_reset_threshold,
  };
}

function mergeIdentity(base: IdentityConfig, raw: unknown): IdentityConfig {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    type: raw.type !== undefined ? asString(raw.type) : base.type,
    mode: raw.mode !== undefined ? asString(raw.mode) : base.mode,
    service_account: raw.service_account !== undefined ? asString(raw.service_account) : base.service_account,
    config: raw.config !== undefined && isRecord(raw.config) ? { ...(base.config ?? {}), ...raw.config } : base.config,
  };
}

function mergeServiceLogs(base: ServiceLogConfig, raw: unknown): ServiceLogConfig {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    stdout: raw.stdout !== undefined ? asBoolean(raw.stdout) : base.stdout,
    stderr: raw.stderr !== undefined ? asBoolean(raw.stderr) : base.stderr,
    multiline: mergeServiceLogMultiline(base.multiline, raw.multiline),
  };
}

function mergeServiceLogMultiline(base: ServiceLogMultilineConfig | undefined, raw: unknown): ServiceLogMultilineConfig | undefined {
  if (raw === undefined) {
    return base;
  }
  const decoded = decodeServiceLogMultiline(raw);
  if (!decoded) {
    return base;
  }
  if (!base) {
    return decoded;
  }
  return {
    start: decoded.start !== undefined ? decoded.start : base.start,
    continuation: decoded.continuation !== undefined ? decoded.continuation : base.continuation,
    max_wait_ms: decoded.max_wait_ms !== undefined ? decoded.max_wait_ms : base.max_wait_ms,
    max_lines: decoded.max_lines !== undefined ? decoded.max_lines : base.max_lines,
  };
}

function mergeRestart(base: RestartConfig, raw: unknown): RestartConfig {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    enabled: raw.enabled !== undefined ? asBoolean(raw.enabled) : base.enabled,
    policy: raw.policy !== undefined ? asString(raw.policy) : base.policy,
    max_retries: raw.max_retries !== undefined ? asNumber(raw.max_retries) : base.max_retries,
    backoff_seconds: raw.backoff_seconds !== undefined ? asNumber(raw.backoff_seconds) : base.backoff_seconds,
  };
}

function mergeStartup(base: StartupConfig, raw: unknown): StartupConfig {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    wait_for_healthy: raw.wait_for_healthy !== undefined ? asBoolean(raw.wait_for_healthy) : base.wait_for_healthy,
    timeout_seconds: raw.timeout_seconds !== undefined ? asNumber(raw.timeout_seconds) : base.timeout_seconds,
  };
}

function mergeContainer(base: ServiceConfig["container"], raw: unknown): ServiceConfig["container"] {
  if (!isRecord(raw)) return base;
  const decoded = decodeContainer(raw);
  if (!decoded) return base;
  return {
    image: raw.image !== undefined ? decoded.image : (base?.image ?? ""),
    runtime: raw.runtime !== undefined ? decoded.runtime : (base?.runtime ?? ""),
    ports: raw.ports !== undefined ? { ...(base?.ports ?? {}), ...decoded.ports } : (base?.ports ?? {}),
    env: raw.env !== undefined ? { ...(base?.env ?? {}), ...decoded.env } : (base?.env ?? {}),
    volumes: raw.volumes !== undefined ? decoded.volumes : (base?.volumes ?? []),
    user: raw.user !== undefined ? decoded.user : (base?.user ?? ""),
    memory: raw.memory !== undefined ? decoded.memory : (base?.memory ?? ""),
    cpus: raw.cpus !== undefined ? decoded.cpus : (base?.cpus ?? ""),
    read_only: raw.read_only !== undefined ? decoded.read_only : (base?.read_only ?? false),
    cap_drop: raw.cap_drop !== undefined ? decoded.cap_drop : (base?.cap_drop ?? []),
    pids_limit: raw.pids_limit !== undefined ? decoded.pids_limit : (base?.pids_limit ?? 0),
  };
}

export function mergeServiceProxyRoutes(cfg: DevctlConfig, provenance?: ConfigProvenance): void {
  const names = Object.keys(cfg.services).sort();
  for (const name of names) {
    const fragments = cfg.services[name]?.proxy ?? [];
    if (fragments.length === 0) {
      continue;
    }
    fragments.forEach((frag, i) => {
      const routeName = fragments.length === 1 ? name : `${name}-${i + 1}`;
      const route = {
        ...frag,
        name: routeName,
      };
      const index = cfg.proxy.routes.length;
      cfg.proxy.routes.push(route);
      if (provenance) {
        recordProvenance(provenance, route, `synthesized from services.${name}.proxy`, "synthesized", `proxy.routes.${index}`);
      }
    });
  }
  synthesizeExposeRoutes(cfg, provenance);
  synthesizeHttpExposeRoutes(cfg, provenance);
}

// Resolve IAP credentials-file paths to absolute and fold the proxy-level
// default into each custom-client route that doesn't set its own. After this,
// a route that should mint from a separate credentials file carries an absolute
// `auth.credentials`, so the token layer reads one field and needs no repo-root
// plumbing. Only custom-client (client_id) routes are eligible — the file is
// only ever consulted when minting for a custom OAuth client.
export function applyProxyCredentials(cfg: DevctlConfig): void {
  const base = cfg.repoRoot || process.cwd();
  const proxyDefault = cfg.proxy.credentials.trim() === "" ? "" : resolveUserPath(cfg.proxy.credentials.trim(), base);
  cfg.proxy.credentials = proxyDefault;
  for (const route of cfg.proxy.routes) {
    applyCredentialsToAuth(route.auth, proxyDefault, base);
  }
  for (const recipe of Object.values(cfg.http)) {
    applyCredentialsToAuth(recipe.request.auth, proxyDefault, base);
  }
}

function applyCredentialsToAuth(auth: RouteAuthConfig, proxyDefault: string, base: string): void {
  if (auth.client_id.trim() === "") {
    return;
  }
  const own = (auth.credentials ?? "").trim();
  auth.credentials = own === "" ? proxyDefault : resolveUserPath(own, base);
}

function appendSynthesizedRoute(cfg: DevctlConfig, route: RouteConfig, via: string, provenance?: ConfigProvenance): void {
  const index = cfg.proxy.routes.length;
  cfg.proxy.routes.push(route);
  if (provenance) {
    recordProvenance(provenance, route, `synthesized from ${via}`, "synthesized", `proxy.routes.${index}`);
  }
}

// Auto-generate a host-based proxy route for each service opted in via
// `expose` (or, under `proxy.gateway`, every HTTP-capable service). The route
// addresses its target by service + port name rather than a fixed url, so the
// proxy resolves the *current* assigned port at request time and follows a
// service that restarts on a new port. Auth is always none: an internal hop
// must never silently acquire the service's identity token — that stays an
// explicit, hand-written choice. Runs last so any explicit route or `proxy`
// fragment of the same name wins (matchRoute is first-match).
function synthesizeExposeRoutes(cfg: DevctlConfig, provenance?: ConfigProvenance): void {
  if (!cfg.proxy.enabled) {
    return;
  }
  const claimed = new Set(cfg.proxy.routes.map((route) => route.name));
  for (const name of Object.keys(cfg.services).sort()) {
    const svc = cfg.services[name];
    if (!svc) {
      continue;
    }
    // An explicit `expose: false` opts the service out even when gateway is on.
    const optedOut = svc.expose.enabled === false;
    const exposed = !optedOut && (svc.expose.enabled === true || (cfg.proxy.gateway && namedPort(svc.ports, "http") !== undefined));
    if (!exposed || claimed.has(name)) {
      continue;
    }
    const via = svc.expose.enabled === true ? `services.${name}.expose` : "proxy.gateway";
    appendSynthesizedRoute(cfg, {
      name,
      match: { host: svc.expose.host || `${name}.local`, path: "" },
      upstream: { url: "", service: name, port: svc.expose.port || "http" },
      auth: emptyRouteAuth(),
    }, via, provenance);
    claimed.add(name);
  }
}

function synthesizeHttpExposeRoutes(cfg: DevctlConfig, provenance?: ConfigProvenance): void {
  if (!cfg.proxy.enabled) {
    return;
  }
  const claimed = new Set(cfg.proxy.routes.map((route) => route.name));
  for (const name of Object.keys(cfg.http).sort()) {
    const recipe = cfg.http[name];
    if (recipe?.expose.enabled) {
      const routeName = claimed.has(`${name}.local`) ? `http:${name}` : `${name}.local`;
      if (!claimed.has(routeName)) {
        appendSynthesizedRoute(cfg, {
          name: routeName,
          match: { host: recipe.expose.host || `${name}.local`, path: "" },
          upstream: { url: "", recipe: name },
          auth: emptyRouteAuth(),
          response_headers: { ...recipe.expose.response_headers },
        }, `http.${name}.expose`, provenance);
        claimed.add(routeName);
      }
    }
  }
}

export function applyTemplates(cfg: DevctlConfig, presence: ConfigPresence = newConfigPresence()): void {
  if (Object.keys(cfg.templates).length === 0) {
    return;
  }
  const resolved: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    resolved[name] = applyTemplateChain(cfg, svc, presence.services[name] ?? new Set(), presence, {});
  }
  cfg.services = resolved;
}

// present: the field names ever explicitly set on svc itself, across every
// source that produced it (see ConfigPresence) — not svc's own decoded
// values, which can't tell "explicitly false/0/[]" apart from "inherit the
// template's value".
function applyTemplateChain(cfg: DevctlConfig, svc: ServiceConfig, present: Set<string>, presence: ConfigPresence, seen: Record<string, boolean>): ServiceConfig {
  if (svc.extends === "") {
    return svc;
  }
  if (seen[svc.extends]) {
    throw new Error(`template cycle involving "${svc.extends}"`);
  }
  const tmpl = cfg.templates[svc.extends] ?? emptyService();
  if (!cfg.templates[svc.extends]) {
    throw new Error(`service extends unknown template "${svc.extends}"`);
  }
  const nextSeen = { ...seen, [svc.extends]: true };
  const tmplPresent = presence.templates[svc.extends] ?? new Set();
  const base = applyTemplateChain(cfg, tmpl, tmplPresent, presence, nextSeen);
  const merged = mergeServiceOverPresence(base, svc, present);
  merged.extends = svc.extends;
  return merged;
}

// Same field-by-field replacement mergeService does, but driven by an
// explicit presence set instead of a raw YAML node — svc is already fully
// decoded (and already carries base's own inherited values wherever it
// wasn't itself set), so only fields present is confirmed to have set are
// taken from svc; everything else keeps base's (the template's) value.
function mergeServiceOverPresence(base: ServiceConfig, svc: ServiceConfig, present: Set<string>): ServiceConfig {
  const out: ServiceConfig = { ...base };
  if (present.has("extends")) {
    out.extends = svc.extends;
  }
  if (present.has("description")) {
    out.description = svc.description;
  }
  if (present.has("command")) {
    out.command = svc.command;
  }
  if (present.has("shell")) {
    out.shell = svc.shell;
  }
  if (present.has("working_dir")) {
    out.working_dir = svc.working_dir;
  }
  if (present.has("dependencies")) {
    out.dependencies = svc.dependencies;
  }
  if (present.has("ports")) {
    out.ports = svc.ports;
  }
  if (present.has("capabilities")) {
    out.capabilities = svc.capabilities;
  }
  if (present.has("proxy")) {
    out.proxy = svc.proxy;
  }
  if (present.has("container")) {
    const container = svc.container;
    const baseContainer = base.container;
    out.container = container && baseContainer ? {
      image: present.has("container.image") ? container.image : baseContainer.image,
      runtime: present.has("container.runtime") ? container.runtime : baseContainer.runtime,
      ports: present.has("container.ports") ? container.ports : baseContainer.ports,
      env: present.has("container.env") ? container.env : baseContainer.env,
      volumes: present.has("container.volumes") ? container.volumes : baseContainer.volumes,
      user: present.has("container.user") ? container.user : baseContainer.user,
      memory: present.has("container.memory") ? container.memory : baseContainer.memory,
      cpus: present.has("container.cpus") ? container.cpus : baseContainer.cpus,
      read_only: present.has("container.read_only") ? container.read_only : baseContainer.read_only,
      cap_drop: present.has("container.cap_drop") ? container.cap_drop : baseContainer.cap_drop,
      pids_limit: present.has("container.pids_limit") ? container.pids_limit : baseContainer.pids_limit,
    } : (container ?? baseContainer);
  }
  if (present.has("watch")) {
    out.watch = svc.watch;
  }
  out.hooks = {
    pre_start: present.has("hooks.pre_start") ? svc.hooks.pre_start : base.hooks.pre_start,
    post_start: present.has("hooks.post_start") ? svc.hooks.post_start : base.hooks.post_start,
  };
  out.health = {
    type: present.has("health.type") ? svc.health.type : base.health.type,
    url: present.has("health.url") ? svc.health.url : base.health.url,
    address: present.has("health.address") ? svc.health.address : base.health.address,
    grpc_service: present.has("health.grpc_service") ? svc.health.grpc_service : base.health.grpc_service,
    command: present.has("health.command") ? svc.health.command : base.health.command,
    interval_seconds: present.has("health.interval_seconds") ? svc.health.interval_seconds : base.health.interval_seconds,
    timeout_seconds: present.has("health.timeout_seconds") ? svc.health.timeout_seconds : base.health.timeout_seconds,
    start_period_seconds: present.has("health.start_period_seconds") ? svc.health.start_period_seconds : base.health.start_period_seconds,
    unhealthy_threshold: present.has("health.unhealthy_threshold") ? svc.health.unhealthy_threshold : base.health.unhealthy_threshold,
    healthy_reset_threshold: present.has("health.healthy_reset_threshold") ? svc.health.healthy_reset_threshold : base.health.healthy_reset_threshold,
  };
  out.identity = {
    type: present.has("identity.type") ? svc.identity.type : base.identity.type,
    mode: present.has("identity.mode") ? svc.identity.mode : base.identity.mode,
    service_account: present.has("identity.service_account") ? svc.identity.service_account : base.identity.service_account,
    config: present.has("identity.config") ? svc.identity.config : base.identity.config,
  };
  out.logs = {
    stdout: present.has("logs.stdout") ? svc.logs.stdout : base.logs.stdout,
    stderr: present.has("logs.stderr") ? svc.logs.stderr : base.logs.stderr,
    multiline: mergeMultilineOverPresence(base.logs.multiline, svc.logs.multiline, present),
  };
  out.restart = {
    enabled: present.has("restart.enabled") ? svc.restart.enabled : base.restart.enabled,
    policy: present.has("restart.policy") ? svc.restart.policy : base.restart.policy,
    max_retries: present.has("restart.max_retries") ? svc.restart.max_retries : base.restart.max_retries,
    backoff_seconds: present.has("restart.backoff_seconds") ? svc.restart.backoff_seconds : base.restart.backoff_seconds,
  };
  out.startup = {
    wait_for_healthy: present.has("startup.wait_for_healthy") ? svc.startup.wait_for_healthy : base.startup.wait_for_healthy,
    timeout_seconds: present.has("startup.timeout_seconds") ? svc.startup.timeout_seconds : base.startup.timeout_seconds,
  };
  out.environment = {
    vars: { ...base.environment.vars, ...svc.environment.vars },
    defaults: { ...base.environment.defaults, ...svc.environment.defaults },
    required: present.has("environment.required") ? svc.environment.required : base.environment.required,
  };
  out.environments = mergeDecodedEnvironments(base.environments, svc.environments);
  if (present.has("default_environment")) {
    out.default_environment = svc.default_environment;
  }
  return out;
}

function mergeMultilineOverPresence(
  base: ServiceLogMultilineConfig | undefined,
  overlay: ServiceLogMultilineConfig | undefined,
  present: Set<string>,
): ServiceLogMultilineConfig | undefined {
  const sectionPresent = present.has("logs.multiline") || [...present].some((key) => key.startsWith("logs.multiline."));
  if (!sectionPresent) {
    return base;
  }
  if (!overlay) {
    return base;
  }
  if (!base) {
    return overlay;
  }
  return {
    start: overlay.start !== undefined || present.has("logs.multiline.start") ? overlay.start : base.start,
    continuation: overlay.continuation !== undefined || present.has("logs.multiline.continuation") ? overlay.continuation : base.continuation,
    max_wait_ms: overlay.max_wait_ms !== undefined || present.has("logs.multiline.max_wait_ms") ? overlay.max_wait_ms : base.max_wait_ms,
    max_lines: overlay.max_lines !== undefined || present.has("logs.multiline.max_lines") ? overlay.max_lines : base.max_lines,
  };
}

function mergeDecodedEnvironments(base: Record<string, EnvConfig>, overlay: Record<string, EnvConfig>): Record<string, EnvConfig> {
  const out = { ...base };
  for (const [name, env] of Object.entries(overlay)) {
    const prior = Object.hasOwn(base, name) ? base[name] ?? emptyEnv() : emptyEnv();
    out[name] = overlayEnv(prior, env);
  }
  return out;
}
