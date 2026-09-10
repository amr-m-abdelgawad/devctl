import { existsSync, readFileSync } from "node:fs";
import type { DevctlConfig } from "../../domain/config/types.ts";
import { secretTemplateLabel } from "../../domain/config/env-ref.ts";
import { configDiff } from "../../domain/config/provenance.ts";
import { Detector } from "../../shared/redaction.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { getDoc, searchDocs } from "./docs-search.ts";
import { GUIDE_SECTIONS, type GuideSection } from "./guide.generated.ts";

export const MCP_LOG_CAP = 200;

export const MCP_RESOURCE_URIS = [
  "devctl://status",
  "devctl://services",
  "devctl://logs",
  "devctl://config",
  "devctl://doctor",
] as const;

export type McpResourceUri = (typeof MCP_RESOURCE_URIS)[number];

import type { McpHost } from "../../ports/mcp-host.ts";

export type { McpHost };

// Ordered so the TUI renders groups in a stable, sensible sequence rather
// than whatever order the tool list happens to be in.
export const MCP_TOOL_CATEGORIES = ["inspect", "logs", "diagnostics", "control", "setup"] as const;

export type McpToolCategory = (typeof MCP_TOOL_CATEGORIES)[number];

export type McpToolDef = {
  readonly name: string;
  // Human-facing name for the TUI. `description` stays the agent-facing text:
  // one string cannot serve both without being wrong for one of them.
  readonly label: string;
  readonly summary: string;
  readonly category: McpToolCategory;
  // Changes the state of the daemon or its services. Surfaced in the TUI
  // because "let an agent look but not touch" is the main reason to disable
  // anything here.
  readonly mutates?: boolean;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "list_services",
    label: "List services",
    summary: "Name, state, health, ports, pid",
    category: "inspect",
    description: "List services with state, health, ports, pid, and last error",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_service",
    label: "Service detail",
    summary: "One service with command, cwd, ports",
    category: "inspect",
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
    label: "Status",
    summary: "Profile, identity, proxy, log counts",
    category: "inspect",
    description: "Profile, session, identity flags (no tokens), proxy, and log counts",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_logs",
    label: "Read logs",
    summary: "Filtered log pages, secrets redacted",
    category: "logs",
    description:
      "Recent log lines, optionally filtered. Capped at 200 events per page. Secrets are redacted. Pass cursor=next_cursor to page forward with no duplicate or same-millisecond-lost events; since/until are plain timestamp filters for a fresh query, not a follow cursor.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        level: { type: "string" },
        search: { type: "string" },
        source: { type: "string" },
        since: { type: "string", description: "Only events at or after this timestamp" },
        until: { type: "string", description: "Only events at or before this timestamp" },
        cursor: { type: "string", description: "Opaque cursor from a previous response's next_cursor; continues forward from exactly there" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_profiles",
    label: "List profiles",
    summary: "Configured profiles and their members",
    category: "inspect",
    description: "Configured profiles and their member services",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_config",
    label: "Read config",
    summary: "Merged project summary, no secret values",
    category: "inspect",
    description: "Merged project summary: services, routes, and proxy listen paths. Route auth includes type, identity, audience, and optional IAP client_id. client_secret is returned only as a ${ENV} template, never a resolved secret.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_config_sources",
    label: "Config sources",
    summary: "Winning and shadowed config sources",
    category: "inspect",
    description: "List effective configuration values with their winning source/layer and any shadowed sources. Secret-like values are redacted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_doctor",
    label: "Run doctor",
    summary: "Environment diagnostics",
    category: "diagnostics",
    description: "Run environment diagnostics",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_services",
    label: "Start services",
    summary: "Start named services or a profile",
    category: "control",
    mutates: true,
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
    label: "Stop services",
    summary: "Stop services and their dependents",
    category: "control",
    mutates: true,
    description:
      "Stop named services, or all started services when names are omitted. Also stops every service that transitively depends on a named one (never a named service's own dependencies, which other running services may still need).",
    inputSchema: {
      type: "object",
      properties: { services: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
  },
  {
    name: "restart_services",
    label: "Restart services",
    summary: "Restart services, optionally cascading",
    category: "control",
    mutates: true,
    description:
      "Restart named services. By default this touches only the named services, not anything that depends on them. Pass cascade=true to also restart their transitive dependents (the same set stop_services would affect).",
    inputSchema: {
      type: "object",
      properties: {
        services: { type: "array", items: { type: "string" } },
        cascade: { type: "boolean", description: "Also restart transitive dependents; default false restarts only the named services" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "reload_config",
    label: "Reload config",
    summary: "Re-read .devctl configuration",
    category: "control",
    mutates: true,
    description: "Reload .devctl configuration",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_task",
    label: "Run task",
    summary: "Run a named one-off task",
    category: "control",
    mutates: true,
    description: "Run a named task from configuration. Output is also written to the log ring as task:<name>.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "start_proxy",
    label: "Start proxy",
    summary: "Start the local reverse proxy",
    category: "control",
    mutates: true,
    description: "Start the local reverse proxy. Same as CLI `devctl proxy start` and TUI start on the proxy screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stop_proxy",
    label: "Stop proxy",
    summary: "Stop the local reverse proxy",
    category: "control",
    mutates: true,
    description: "Stop the local reverse proxy and leave it suppressed until start_proxy (or CLI/TUI start) runs again.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "exec_service",
    label: "Execute in service",
    summary: "Run a command in a resolved service context",
    category: "control",
    mutates: true,
    description: "Run an arbitrary command with a service's fully resolved environment and working directory, whether or not it is running. Output and print_env values are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        command: { type: "array", items: { type: "string" } },
        print_env: { type: "boolean", description: "Return the resolved environment without executing a command" },
      },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    name: "get_setup_guide",
    label: "Setup guide",
    summary: "How to author a .devctl for this repo",
    category: "setup",
    description:
      "The devctl onboarding guide: how to survey a repository and author a .devctl configuration for it. Read section=procedure first; read section=authoring BEFORE writing any YAML (it carries the rules the loader rejects on, which the JSON Schema does not state); read section=discovery for mapping compose/package.json/pyproject/Terraform/k8s/.env to services. Write the files with your own editing tools — this server does not write them — then check your work with validate_config.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["procedure", "authoring", "discovery"],
          description: "Which part of the guide to return; defaults to procedure",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_docs",
    label: "Search docs",
    summary: "Search the embedded product documentation",
    category: "setup",
    description:
      "Search the compiled-in product documentation (docs/*.md plus the onboarding skill). Returns ranked pages with short snippets for discovery. To read a full page, pass a hit's `path` to get_doc. Use this for IAP, proxy, MCP, configuration, and similar topics; use get_setup_guide for the full onboarding procedure.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a short phrase to search for" },
        limit: { type: "integer", description: "Maximum hits to return (default 5, max 10)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_doc",
    label: "Get doc",
    summary: "Read a full documentation page",
    category: "setup",
    description:
      "Return the complete text of one embedded documentation page. Pass the `path` from a search_docs hit (e.g. docs/proxy.md) — search_docs only returns short snippets, so use this to read the whole page. A basename like proxy.md also resolves when unambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Doc path from a search_docs hit, e.g. docs/proxy.md" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_config",
    label: "Validate config",
    summary: "Check configuration or a draft for errors",
    category: "setup",
    description:
      "Validate devctl configuration and return the exact issues the loader would report. With no arguments, validates what is on disk. Pass text to validate a candidate config.yaml before writing it — the candidate is run through the real load pipeline (modular services/profiles, overlays, templates), so it works even when no configuration exists yet. This is the only way to validate over MCP; there is no CLI round-trip needed.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Candidate config.yaml contents to validate instead of the file on disk",
        },
      },
      additionalProperties: false,
    },
  },
];

// A deny-list, deliberately: everything is on unless it was explicitly turned
// off, so a tool added in a later version is available to existing users
// instead of silently missing because their saved list predates it.
export function toolEnabled(name: string, disabled: readonly string[] | undefined): boolean {
  return !(disabled ?? []).includes(name);
}

export function enabledTools(disabled: readonly string[] | undefined): readonly McpToolDef[] {
  return MCP_TOOLS.filter((tool) => toolEnabled(tool.name, disabled));
}

export function isKnownToolName(name: string): boolean {
  return MCP_TOOLS.some((tool) => tool.name === name);
}

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
    container: svc.container ? { ...svc.container, env: detector.redactMap(svc.container.env) } : undefined,
  };
}

export function getStatusSummary(snap: StatusSnapshot): unknown {
  return {
    session_id: snap.session_id,
    repo_root: snap.repo_root,
    profile: snap.profile,
    // Present only when the daemon booted with no configuration on disk. An
    // agent seeing this should call get_setup_guide and author one; no
    // service can start until it does.
    setup_mode: snap.setup_mode === true ? true : undefined,
    identity: {
      user: snap.identity.user,
      project: snap.identity.project,
      adc: snap.identity.adc,
      iap: snap.identity.iap,
      service_accounts: snap.identity.service_accounts,
      service_account_status: snap.identity.service_account_status,
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
  // A cursor names an exact sequence position, so resuming from one pages
  // strictly forward from there — immune to the same-millisecond
  // duplicate/loss a plain timestamp boundary can't avoid. since/until stay
  // ordinary inclusive filters for a fresh query; they are not this tool's
  // follow mechanism.
  const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
  const page = await host.logsPage({
    services: service === "" ? [] : [service],
    level: typeof args.level === "string" ? args.level : "",
    search: typeof args.search === "string" ? args.search : "",
    source: typeof args.source === "string" ? args.source : "",
    since,
    until: typeof args.until === "string" ? args.until : "",
    cursor,
    direction: cursor ? "forward" : undefined,
    limit: MCP_LOG_CAP,
  });
  const detector = detectorFor(host.config());
  return {
    events: page.events.map((ev) => ({
      timestamp: ev.timestamp,
      service: ev.service,
      source: ev.source,
      level: ev.level,
      message: detector.redactText(ev.message),
      pid: ev.pid,
    })),
    // Same meaning it always had: more (older) history exists than this
    // capped page shows. has_more is the complementary forward-looking
    // signal for a cursor-following caller — events already waiting beyond
    // this page, worth fetching again immediately rather than waiting.
    truncated: page.hasPrev,
    has_more: page.hasNext,
    next_since: page.events[page.events.length - 1]?.timestamp ?? since,
    next_cursor: page.nextCursor,
    session_changed: page.sessionChanged,
  };
}

export function listProfiles(cfg: DevctlConfig): unknown {
  return Object.entries(cfg.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, profile]) => ({ name, services: profile.services }));
}

function nonempty(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

function routeConfigSummary(route: DevctlConfig["proxy"]["routes"][number]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: route.name,
    match: route.match,
    upstream: route.upstream.url !== "" ? route.upstream.url : nonempty(route.upstream.service ?? "") ? `service:${route.upstream.service}${route.upstream.port ? `/${route.upstream.port}` : ""}` : "",
    auth: route.auth.type,
  };
  const identity = nonempty(route.auth.identity.type);
  const audience = nonempty(route.auth.audience);
  const serviceAccount = nonempty(route.auth.identity.service_account || route.auth.service_account);
  const clientId = nonempty(route.auth.client_id);
  const clientSecret = secretTemplateLabel(route.auth.client_secret);
  const credentials = nonempty(route.auth.credentials ?? "");
  if (identity) {
    out.identity = identity;
  }
  if (audience) {
    out.audience = audience;
  }
  if (serviceAccount) {
    out.service_account = serviceAccount;
  }
  if (clientId) {
    out.client_id = clientId;
  }
  if (clientSecret) {
    out.client_secret = clientSecret;
  }
  if (credentials) {
    out.credentials = credentials;
  }
  return out;
}

export function getConfigSummary(cfg: DevctlConfig): unknown {
  const services = Object.entries(cfg.services).map(([name, svc]) => ({
    name,
    description: svc.description,
    command: svc.command.args,
    cwd: svc.working_dir,
    ports: svc.ports.map((port) => ({ name: port.name, value: port.auto ? 0 : port.value, auto: port.auto })),
    dependencies: svc.dependencies,
    container: svc.container ? { image: svc.container.image, runtime: svc.container.runtime || "docker", ports: svc.container.ports, volumes: svc.container.volumes } : undefined,
  }));
  return {
    project: cfg.project.name,
    config_path: cfg.configPath,
    repo_root: cfg.repoRoot,
    services,
    proxy: {
      enabled: cfg.proxy.enabled,
      gateway: cfg.proxy.gateway,
      credentials: cfg.proxy.credentials,
      listen: { host: cfg.proxy.listen.host, port: cfg.proxy.listen.port },
      routes: cfg.proxy.routes.map((route) => routeConfigSummary(route)),
    },
  };
}

export function getConfigSources(cfg: DevctlConfig): unknown {
  const detector = detectorFor(cfg);
  return {
    entries: configDiff(cfg).map((entry) => {
      const serialized = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      return { ...entry, value: detector.redactMap({ [entry.path]: serialized })[entry.path] };
    }),
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
    case "get_config_sources":
      return getConfigSources(host.config());
    case "run_doctor":
      return host.doctor();
    case "start_services":
      return host.start({
        services: stringList(args.services),
        profile: typeof args.profile === "string" && args.profile !== "" ? args.profile : undefined,
      });
    case "stop_services":
      await host.stop(stringList(args.services));
      return { ok: true };
    case "restart_services":
      await host.restart(stringList(args.services), args.cascade === true);
      return { ok: true };
    case "reload_config":
      return host.reload();
    case "run_task": {
      if (typeof args.name !== "string" || args.name === "") {
        throw new Error("name is required");
      }
      const result = await host.runTask(args.name);
      const detector = detectorFor(host.config());
      return {
        ...result,
        stdout: detector.redactText(result.stdout),
        stderr: detector.redactText(result.stderr),
      };
    }
    case "start_proxy":
      await host.startProxy();
      return { ok: true };
    case "stop_proxy":
      await host.stopProxy();
      return { ok: true };
    case "exec_service": {
      if (typeof args.service !== "string" || args.service === "") throw new Error("service is required");
      if (!host.exec) throw new Error("exec is unavailable");
      const result = await host.exec(args.service, stringList(args.command), args.print_env === true);
      const detector = detectorFor(host.config());
      return {
        ...result,
        stdout: detector.redactText(result.stdout),
        stderr: detector.redactText(result.stderr),
        environment: result.environment ? detector.redactMap(result.environment) : undefined,
      };
    }
    case "get_setup_guide":
      return getSetupGuide(args);
    case "search_docs":
      return searchDocs(typeof args.query === "string" ? args.query : "", typeof args.limit === "number" ? args.limit : undefined);
    case "get_doc":
      return getDoc(typeof args.path === "string" ? args.path : "");
    case "validate_config":
      return validateConfig(host, args);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function getSetupGuide(args: Record<string, unknown>): unknown {
  const requested = typeof args.section === "string" ? args.section : "procedure";
  const section = requested in GUIDE_SECTIONS ? (requested as GuideSection) : "procedure";
  return { section, text: GUIDE_SECTIONS[section], sections: Object.keys(GUIDE_SECTIONS) };
}

// Runs in the supervisor process, so it has the repository on disk: with no
// `text` it validates what is actually written there, and with `text` it
// substitutes that candidate at the main-file read step and runs the rest of
// the real pipeline over it. The candidate path works before any
// configuration exists — which is the whole point in setup mode, where an
// agent needs to check a draft it has not written yet.
export function validateConfig(host: McpHost, args: Record<string, unknown>): unknown {
  const cfg = host.config();
  if (typeof args.text === "string") {
    const issues = host.validateConfigText(args.text);
    return { valid: issues.length === 0, issues, source: "candidate", config_path: cfg.configPath };
  }
  if (!existsSync(cfg.configPath)) {
    return {
      valid: false,
      issues: [`no configuration at ${cfg.configPath}`],
      source: "disk",
      config_path: cfg.configPath,
      setup_mode: true,
    };
  }
  const issues = host.validateConfigText(readFileSync(cfg.configPath, "utf8"));
  return { valid: issues.length === 0, issues, source: "disk", config_path: cfg.configPath };
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
