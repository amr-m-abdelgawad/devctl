import {
  emptyCommand,
  emptyEnv,
  emptyHealth,
  emptyIdentity,
  emptyService,
  type Command,
  type DevctlConfig,
  type EnvConfig,
  type HealthCheckConfig,
  type IdentityConfig,
  type PortSpec,
  type ProfileConfig,
  type ProxyConfig,
  type RestartConfig,
  type RouteAuthConfig,
  type RouteConfig,
  type RouteIdentity,
  type ServiceConfig,
  type StartupConfig,
} from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => asString(item));
}

export function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = asString(item);
  }
  return out;
}

export function decodeCommand(value: unknown): Command {
  if (typeof value === "string") {
    return { args: value.split(/\s+/).filter((part) => part !== ""), shell: false };
  }
  if (Array.isArray(value)) {
    return { args: value.map((item) => asString(item)), shell: false };
  }
  return emptyCommand();
}

export function decodePorts(value: unknown): PortSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string" || typeof value === "number") {
    return [decodePortNode(value, "http")];
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => decodePortNode(item, `port_${i}`));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, item]) => decodePortNode(item, name));
  }
  return [];
}

function decodePortNode(value: unknown, name: string): PortSpec {
  if (typeof value === "string" && value.toLowerCase() === "auto") {
    return { name, value: 0, auto: true };
  }
  return { name, value: asNumber(value), auto: false };
}

export function decodeEnv(value: unknown): EnvConfig {
  if (!isRecord(value)) {
    return emptyEnv();
  }
  const vars: Record<string, string> = {};
  let required: string[] = [];
  let defaults: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "required") {
      required = asStringArray(item);
    } else if (key === "defaults") {
      defaults = asStringMap(item);
    } else {
      vars[key] = asString(item);
    }
  }
  return { vars, required, defaults };
}

export function decodeIdentity(value: unknown): IdentityConfig {
  if (!isRecord(value)) {
    return emptyIdentity();
  }
  return {
    type: asString(value.type),
    mode: asString(value.mode),
    service_account: asString(value.service_account),
  };
}

export function decodeHealth(value: unknown): HealthCheckConfig {
  if (!isRecord(value)) {
    return emptyHealth();
  }
  return {
    type: asString(value.type),
    url: asString(value.url),
    address: asString(value.address),
    command: decodeCommand(value.command),
    interval_seconds: asNumber(value.interval_seconds),
    timeout_seconds: asNumber(value.timeout_seconds),
  };
}

export function decodeRestart(value: unknown): RestartConfig {
  if (!isRecord(value)) {
    return { policy: "", max_retries: 0, backoff_seconds: 0 };
  }
  const enabled = value.enabled === undefined ? undefined : asBoolean(value.enabled);
  return {
    enabled,
    policy: asString(value.policy),
    max_retries: asNumber(value.max_retries),
    backoff_seconds: asNumber(value.backoff_seconds),
  };
}

export function decodeStartup(value: unknown): StartupConfig {
  if (!isRecord(value)) {
    return { wait_for_healthy: false, timeout_seconds: 0 };
  }
  return {
    wait_for_healthy: asBoolean(value.wait_for_healthy),
    timeout_seconds: asNumber(value.timeout_seconds),
  };
}

export function decodeService(value: unknown): ServiceConfig {
  if (!isRecord(value)) {
    return emptyService();
  }
  const logs = isRecord(value.logs) ? value.logs : {};
  return {
    extends: asString(value.extends),
    description: asString(value.description),
    command: decodeCommand(value.command),
    shell: asBoolean(value.shell),
    working_dir: asString(value.working_dir),
    dependencies: asStringArray(value.dependencies),
    ports: decodePorts(value.ports),
    environment: decodeEnv(value.environment),
    health: decodeHealth(value.health),
    identity: decodeIdentity(value.identity),
    logs: { stdout: asBoolean(logs.stdout), stderr: asBoolean(logs.stderr) },
    restart: decodeRestart(value.restart),
    startup: decodeStartup(value.startup),
    capabilities: asStringArray(value.capabilities),
    proxy: decodeServiceProxy(value.proxy),
  };
}

export function decodeServiceProxy(value: unknown): RouteConfig[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => decodeRoute(item));
  }
  if (isRecord(value)) {
    return [decodeRoute(value)];
  }
  return [];
}

export function decodeProfile(value: unknown): ProfileConfig {
  if (!isRecord(value)) {
    return { services: [], environment: {} };
  }
  return {
    services: asStringArray(value.services),
    environment: asStringMap(value.environment),
  };
}

function decodeRouteIdentity(value: unknown): RouteIdentity {
  if (typeof value === "string") {
    return { type: value, service_account: "" };
  }
  if (!isRecord(value)) {
    return { type: "", service_account: "" };
  }
  return { type: asString(value.type), service_account: asString(value.service_account) };
}

function decodeRouteAuth(value: unknown): RouteAuthConfig {
  if (!isRecord(value)) {
    return { type: "", identity: { type: "", service_account: "" }, audience: "", service_account: "" };
  }
  return {
    type: asString(value.type),
    identity: decodeRouteIdentity(value.identity),
    audience: asString(value.audience),
    service_account: asString(value.service_account),
  };
}

export function decodeRoute(value: unknown): RouteConfig {
  if (!isRecord(value)) {
    return {
      name: "",
      match: { host: "", path: "" },
      upstream: { url: "" },
      auth: { type: "", identity: { type: "", service_account: "" }, audience: "", service_account: "" },
    };
  }
  const match = isRecord(value.match) ? value.match : {};
  const upstream = isRecord(value.upstream) ? value.upstream : {};
  return {
    name: asString(value.name),
    match: { host: asString(match.host), path: asString(match.path) },
    upstream: { url: asString(upstream.url) },
    auth: decodeRouteAuth(value.auth),
  };
}

export function applyRoot(cfg: DevctlConfig, raw: Record<string, unknown>): void {
  if (raw.version !== undefined) {
    cfg.version = asNumber(raw.version);
  }
  if (isRecord(raw.project)) {
    cfg.project.name = asString(raw.project.name);
  }
  if (isRecord(raw.google)) {
    cfg.google.project_id = asString(raw.google.project_id);
    cfg.google.region = asString(raw.google.region);
  }
  if (isRecord(raw.profiles)) {
    for (const [name, value] of Object.entries(raw.profiles)) {
      cfg.profiles[name] = decodeProfile(value);
    }
  }
  if (isRecord(raw.templates)) {
    for (const [name, value] of Object.entries(raw.templates)) {
      cfg.templates[name] = decodeService(value);
    }
  }
  if (isRecord(raw.services)) {
    for (const [name, value] of Object.entries(raw.services)) {
      cfg.services[name] = decodeService(value);
    }
  }
  if (isRecord(raw.proxy)) {
    applyProxy(cfg.proxy, raw.proxy);
  }
  if (isRecord(raw.logs)) {
    cfg.logs.max_memory_events = asNumber(raw.logs.max_memory_events) || cfg.logs.max_memory_events;
    if (isRecord(raw.logs.persistence)) {
      cfg.logs.persistence.enabled = raw.logs.persistence.enabled !== false;
      cfg.logs.persistence.directory = asString(raw.logs.persistence.directory) || cfg.logs.persistence.directory;
      cfg.logs.persistence.retention_days = asNumber(raw.logs.persistence.retention_days) || cfg.logs.persistence.retention_days;
      cfg.logs.persistence.max_session_logs = asNumber(raw.logs.persistence.max_session_logs);
    }
  }
  if (isRecord(raw.auth)) {
    cfg.auth.refresh_threshold_seconds = asNumber(raw.auth.refresh_threshold_seconds) || cfg.auth.refresh_threshold_seconds;
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
    cfg.ui.theme = asString(raw.ui.theme) || cfg.ui.theme;
    cfg.ui.keymap = asStringMap(raw.ui.keymap);
  }
  if (isRecord(raw.secrets)) {
    cfg.secrets.extra_markers = asStringArray(raw.secrets.extra_markers);
    cfg.secrets.extra_patterns = asStringArray(raw.secrets.extra_patterns);
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
  proxy.enabled = asBoolean(raw.enabled);
  if (isRecord(raw.listen)) {
    proxy.listen.host = asString(raw.listen.host) || proxy.listen.host;
    proxy.listen.port = asNumber(raw.listen.port) || proxy.listen.port;
  }
  if (isRecord(raw.token_endpoint)) {
    proxy.token_endpoint.enabled = asBoolean(raw.token_endpoint.enabled);
    proxy.token_endpoint.host = asString(raw.token_endpoint.host);
    proxy.token_endpoint.port = asNumber(raw.token_endpoint.port);
  }
  if (Array.isArray(raw.routes)) {
    proxy.routes = raw.routes.map((route) => decodeRoute(route));
  }
}
