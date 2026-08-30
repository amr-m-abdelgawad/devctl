import { type DevctlConfig } from "../config/index.ts";
import { type Report } from "../doctor.ts";
import { type LogEvent } from "../logs.ts";
import { Detector } from "../secrets.ts";
import { type LogsRequest, type ReloadResult, type StartRequest, type StatusSnapshot } from "../types.ts";

export const MCP_LOG_CAP = 200;

export const MCP_RESOURCE_URIS = [
  "devctl://status",
  "devctl://services",
  "devctl://logs",
  "devctl://config",
  "devctl://doctor",
] as const;

export type McpResourceUri = (typeof MCP_RESOURCE_URIS)[number];

export type McpHost = {
  status(): StatusSnapshot;
  logs(req: LogsRequest): LogEvent[] | Promise<LogEvent[]>;
  config(): DevctlConfig;
  start(req: StartRequest): Promise<unknown>;
  stop(names: string[]): Promise<void>;
  restart(names: string[]): Promise<void>;
  reload(): Promise<ReloadResult>;
  doctor(): Promise<Report>;
};

export type McpToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "list_services",
    description: "List services with state, health, ports, pid, and last error",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_service",
    description: "One service plus command, cwd, and ports. Environment values are redacted.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "Profile, session, identity flags (no tokens), proxy, and log counts",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_logs",
    description: "Recent log lines, optionally filtered. Capped at 200 events. Secrets are redacted. Pass since=next_since to read only newer lines.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        level: { type: "string" },
        search: { type: "string" },
        source: { type: "string" },
        since: { type: "string", description: "Follow cursor from a previous next_since; only events after this timestamp" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_profiles",
    description: "Configured profiles and their member services",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_config",
    description: "Merged project summary: services, routes, and proxy listen paths. No secret env values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_doctor",
    description: "Run environment diagnostics",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_services",
    description: "Start named services, or a profile when names are omitted. Empty start uses profile, then the active session profile, then the first configured profile — never every service.",
    inputSchema: {
      type: "object",
      properties: {
        services: { type: "array", items: { type: "string" } },
        profile: { type: "string", description: "Profile to start when services is omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stop_services",
    description: "Stop named services, or all started services when names are omitted",
    inputSchema: {
      type: "object",
      properties: { services: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
  },
  {
    name: "restart_services",
    description: "Restart named services",
    inputSchema: {
      type: "object",
      properties: { services: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
  },
  {
    name: "reload_config",
    description: "Reload .devctl configuration",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function detectorFor(cfg: DevctlConfig): Detector {
  return new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns);
}

export function listServices(snap: StatusSnapshot): unknown {
  return Object.values(snap.services).map((rt) => ({
    name: rt.name,
    state: rt.state,
    health: rt.health,
    ports: rt.ports,
    pid: rt.pid,
    last_error: rt.last_error,
  }));
}

export function getService(host: McpHost, name: string): unknown {
  const cfg = host.config();
  const svc = cfg.services[name];
  if (!svc) {
    throw new Error(`unknown service ${name}`);
  }
  const snap = host.status();
  const rt = snap.services[name];
  const detector = detectorFor(cfg);
  return {
    name,
    state: rt?.state,
    health: rt?.health,
    pid: rt?.pid,
    last_error: rt?.last_error,
    command: svc.command.args,
    cwd: svc.working_dir,
    ports: rt?.ports ?? Object.fromEntries(svc.ports.map((port) => [port.name, port.value])),
    environment: detector.redactMap({ ...svc.environment.defaults, ...svc.environment.vars }),
  };
}

export function getStatusSummary(snap: StatusSnapshot): unknown {
  return {
    session_id: snap.session_id,
    repo_root: snap.repo_root,
    profile: snap.profile,
    identity: {
      user: snap.identity.user,
      project: snap.identity.project,
      adc: snap.identity.adc,
      iap: snap.identity.iap,
      service_accounts: snap.identity.service_accounts,
    },
    proxy: {
      running: snap.proxy.running,
      address: snap.proxy.address,
      routes: snap.proxy.routes,
    },
    logs: snap.logs,
    mcp: snap.mcp
      ? { running: snap.mcp.running, address: snap.mcp.address, port: snap.mcp.port }
      : { running: false },
  };
}

export async function getLogs(host: McpHost, args: Record<string, unknown>): Promise<unknown> {
  const service = typeof args.service === "string" ? args.service : "";
  const since = typeof args.since === "string" ? args.since : "";
  const events = await host.logs({
    services: service === "" ? [] : [service],
    level: typeof args.level === "string" ? args.level : "",
    search: typeof args.search === "string" ? args.search : "",
    source: typeof args.source === "string" ? args.source : "",
    since,
  });
  const detector = detectorFor(host.config());
  const fresh = since === "" ? events : events.filter((ev) => ev.timestamp > since);
  const capped = fresh.slice(-MCP_LOG_CAP);
  const last = capped[capped.length - 1]?.timestamp ?? since;
  return {
    events: capped.map((ev) => ({
      timestamp: ev.timestamp,
      service: ev.service,
      source: ev.source,
      level: ev.level,
      message: detector.redactText(ev.message),
      pid: ev.pid,
    })),
    truncated: events.length > MCP_LOG_CAP,
    next_since: last,
  };
}

export function listProfiles(cfg: DevctlConfig): unknown {
  return Object.entries(cfg.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, profile]) => ({ name, services: profile.services }));
}

export function getConfigSummary(cfg: DevctlConfig): unknown {
  const services = Object.entries(cfg.services).map(([name, svc]) => ({
    name,
    description: svc.description,
    command: svc.command.args,
    cwd: svc.working_dir,
    ports: svc.ports.map((port) => ({ name: port.name, value: port.auto ? 0 : port.value, auto: port.auto })),
    dependencies: svc.dependencies,
  }));
  return {
    project: cfg.project.name,
    config_path: cfg.configPath,
    repo_root: cfg.repoRoot,
    services,
    proxy: {
      enabled: cfg.proxy.enabled,
      listen: { host: cfg.proxy.listen.host, port: cfg.proxy.listen.port },
      routes: cfg.proxy.routes.map((route) => ({
        name: route.name,
        match: route.match,
        upstream: route.upstream.url,
        auth: route.auth.type,
      })),
    },
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

export async function callMcpTool(host: McpHost, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_services":
      return listServices(host.status());
    case "get_service":
      if (typeof args.name !== "string" || args.name === "") {
        throw new Error("name is required");
      }
      return getService(host, args.name);
    case "get_status":
      return getStatusSummary(host.status());
    case "get_logs":
      return getLogs(host, args);
    case "list_profiles":
      return listProfiles(host.config());
    case "get_config":
      return getConfigSummary(host.config());
    case "run_doctor":
      return host.doctor();
    case "start_services":
      return host.start({
        services: stringList(args.services),
        profile: typeof args.profile === "string" ? args.profile : "",
      });
    case "stop_services":
      await host.stop(stringList(args.services));
      return { ok: true };
    case "restart_services":
      await host.restart(stringList(args.services));
      return { ok: true };
    case "reload_config":
      return host.reload();
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function isMcpResourceUri(uri: string): uri is McpResourceUri {
  return (MCP_RESOURCE_URIS as readonly string[]).includes(uri);
}

export async function readMcpResource(host: McpHost, uri: string): Promise<unknown> {
  switch (uri) {
    case "devctl://status":
      return getStatusSummary(host.status());
    case "devctl://services":
      return listServices(host.status());
    case "devctl://logs":
      return getLogs(host, {});
    case "devctl://config":
      return getConfigSummary(host.config());
    case "devctl://doctor":
      return host.doctor();
    default:
      throw new Error(`unknown resource ${uri}`);
  }
}
