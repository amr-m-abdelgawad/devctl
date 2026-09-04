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
  decodeService,
  decodeTask,
  decodeServiceProxy,
  isRecord,
  presentKeys,
} from "./decode.ts";
import {
  emptyService,
  type DevctlConfig,
  type ConfigProvenance,
  type EnvConfig,
  type HealthCheckConfig,
  type IdentityConfig,
  type ProfileConfig,
  type ProxyConfig,
  type RestartConfig,
  type ServiceConfig,
  type ServiceLogConfig,
  type StartupConfig,
  type TaskConfig,
} from "./types.ts";

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
const NESTED_OBJECT_FIELDS = ["environment", "restart", "startup", "health", "logs", "identity", "container", "hooks"] as const;

export function recordPresence(map: FieldPresenceMap, name: string, raw: unknown): void {
  const keys = presentKeys(raw);
  if (isRecord(raw)) {
    for (const field of NESTED_OBJECT_FIELDS) {
      const nested = (raw as Record<string, unknown>)[field];
      if (isRecord(nested)) {
        for (const key of Object.keys(nested)) {
          keys.add(`${field}.${key}`);
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
}

function applyProxy(proxy: ProxyConfig, raw: Record<string, unknown>): void {
  if (raw.enabled !== undefined) {
    proxy.enabled = asBoolean(raw.enabled);
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
    health: mergeHealth(base.health, raw.health),
    identity: mergeIdentity(base.identity, raw.identity),
    logs: mergeServiceLogs(base.logs, raw.logs),
    restart: mergeRestart(base.restart, raw.restart),
    startup: mergeStartup(base.startup, raw.startup),
    container: mergeContainer(base.container, raw.container),
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
  return out;
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
        name: routeName,
        match: frag.match,
        upstream: frag.upstream,
        auth: frag.auth,
      };
      const index = cfg.proxy.routes.length;
      cfg.proxy.routes.push(route);
      if (provenance) {
        recordProvenance(provenance, route, `synthesized from services.${name}.proxy`, "synthesized", `proxy.routes.${index}`);
      }
    });
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
    } : (container ?? baseContainer);
  }
  out.hooks = {
    pre_start: present.has("hooks.pre_start") ? svc.hooks.pre_start : base.hooks.pre_start,
    post_start: present.has("hooks.post_start") ? svc.hooks.post_start : base.hooks.post_start,
  };
  out.health = {
    type: present.has("health.type") ? svc.health.type : base.health.type,
    url: present.has("health.url") ? svc.health.url : base.health.url,
    address: present.has("health.address") ? svc.health.address : base.health.address,
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
  return out;
}
