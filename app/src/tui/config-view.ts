import { emptyService, listenAddress, refreshThreshold, type DevctlConfig, type RouteConfig, type ServiceConfig } from "../config/index.ts";
import { serviceCommandText, serviceHealthText, serviceIdentityText, servicePortsText, serviceRestartText } from "./helpers.ts";

export type ConfigChipTone = "primary" | "accent" | "success" | "warning" | "error" | "info" | "muted" | "idle";

export type ConfigFact = {
  readonly label: string;
  readonly value: string;
  readonly tone?: "text" | "success" | "warning" | "muted" | "error";
};

export type ConfigChip = {
  readonly text: string;
  readonly tone: ConfigChipTone;
};

export type ConfigServiceRow = {
  readonly name: string;
  readonly extends: string;
  readonly command: string;
  readonly ports: string;
  readonly identity: string;
  readonly health: string;
  readonly depends: string;
  readonly restart: string;
};

export type ConfigRouteRow = {
  readonly name: string;
  readonly match: string;
  readonly upstream: string;
  readonly auth: string;
  readonly identity: string;
};

export type ConfigProfileRow = {
  readonly name: string;
  readonly services: string;
  readonly env: string;
};

export type ConfigNamedSummary = {
  readonly name: string;
  readonly summary: string;
};

export function configHeaderChips(cfg: DevctlConfig): ConfigChip[] {
  const services = Object.keys(cfg.services).length;
  const profiles = Object.keys(cfg.profiles).length;
  const routes = cfg.proxy.routes.length;
  const chips: ConfigChip[] = [
    { text: cfg.project.name || "unnamed", tone: "primary" },
    { text: `schema ${cfg.version}`, tone: "muted" },
    { text: `${services} service${services === 1 ? "" : "s"}`, tone: services > 0 ? "info" : "idle" },
    { text: `${profiles} profile${profiles === 1 ? "" : "s"}`, tone: profiles > 0 ? "info" : "idle" },
    { text: cfg.proxy.enabled ? "proxy on" : "proxy off", tone: cfg.proxy.enabled ? "success" : "idle" },
  ];
  if (routes > 0) {
    chips.push({ text: `${routes} route${routes === 1 ? "" : "s"}`, tone: "info" });
  }
  return chips;
}

export function configProjectFacts(cfg: DevctlConfig, version: string): ConfigFact[] {
  return [
    { label: "path", value: cfg.configPath || "—" },
    { label: "repo", value: cfg.repoRoot || "—" },
    { label: "devctl", value: version },
    { label: "schema", value: String(cfg.version) },
  ];
}

export function configGoogleFacts(cfg: DevctlConfig): ConfigFact[] {
  return [
    { label: "project", value: cfg.google.project_id || "(unset)", tone: cfg.google.project_id ? "text" : "muted" },
    { label: "region", value: cfg.google.region || "(unset)", tone: cfg.google.region ? "text" : "muted" },
  ];
}

export function configRuntimeFacts(cfg: DevctlConfig): ConfigFact[] {
  const exit = configExitText(cfg);
  return [
    { label: "exit", value: exit, tone: exit === "ask on quit" ? "warning" : "text" },
    { label: "grace", value: `${cfg.shutdown.grace_seconds}s` },
    { label: "refresh", value: `${refreshThreshold(cfg.auth)}s` },
    { label: "env", value: cfg.environment.sources.join(", ") || "—", tone: cfg.environment.sources.length > 0 ? "text" : "muted" },
    { label: "theme", value: cfg.ui.theme || "system" },
  ];
}

export function configLogFacts(cfg: DevctlConfig): ConfigFact[] {
  const persist = cfg.logs.persistence;
  return [
    { label: "memory", value: `${cfg.logs.max_memory_events} events` },
    { label: "persist", value: persist.enabled ? persist.directory : "off", tone: persist.enabled ? "text" : "muted" },
    { label: "keep", value: persist.enabled ? `${persist.retention_days}d · ${persist.max_session_logs || "∞"} sessions` : "—" },
  ];
}

export function configProxyFacts(cfg: DevctlConfig): ConfigFact[] {
  return [
    { label: "listen", value: listenAddress(cfg.proxy.listen), tone: cfg.proxy.enabled ? "text" : "muted" },
    { label: "token", value: tokenEndpointText(cfg), tone: cfg.proxy.token_endpoint.enabled ? "text" : "muted" },
  ];
}

export function configServiceRows(cfg: DevctlConfig): ConfigServiceRow[] {
  return Object.keys(cfg.services)
    .sort()
    .map((name) => {
      const svc = cfg.services[name] ?? emptyService();
      return {
        name,
        extends: svc.extends || "—",
        command: serviceCommandText(svc),
        ports: servicePortsText(svc),
        identity: serviceIdentityText(svc),
        health: serviceHealthText(svc),
        depends: svc.dependencies.join(", ") || "—",
        restart: serviceRestartText(svc),
      };
    });
}

export function configRouteRows(cfg: DevctlConfig): ConfigRouteRow[] {
  return cfg.proxy.routes.map((route) => ({
    name: route.name || route.match.host || "(unnamed)",
    match: routeMatchText(route),
    upstream: route.upstream.url || "—",
    auth: route.auth.type || "none",
    identity: routeIdentityText(route),
  }));
}

export function configProfileRows(cfg: DevctlConfig): ConfigProfileRow[] {
  return Object.keys(cfg.profiles)
    .sort()
    .map((name) => {
      const profile = cfg.profiles[name];
      const envKeys = Object.keys(profile?.environment ?? {}).sort();
      return {
        name,
        services: profile?.services.join(", ") || "—",
        env: envKeys.length > 0 ? envKeys.join(", ") : "—",
      };
    });
}

export function configTemplateRows(cfg: DevctlConfig): ConfigNamedSummary[] {
  return Object.keys(cfg.templates)
    .sort()
    .map((name) => ({
      name,
      summary: templateSummary(cfg.templates[name]),
    }));
}

export function configExtraFacts(cfg: DevctlConfig): ConfigFact[] {
  const tools = cfg.doctor.tools.map((tool) => tool.name || tool.command).filter((name) => name !== "");
  const plugins = cfg.plugins.map((plugin) => plugin.path).filter((path) => path !== "");
  const keymap = Object.keys(cfg.ui.keymap);
  const secrets = [...cfg.secrets.extra_markers, ...cfg.secrets.extra_patterns];
  return [
    { label: "doctor", value: tools.join(", ") || "—", tone: tools.length > 0 ? "text" : "muted" },
    { label: "plugins", value: plugins.join(", ") || "—", tone: plugins.length > 0 ? "text" : "muted" },
    { label: "keymap", value: keymap.length > 0 ? `${keymap.length} override${keymap.length === 1 ? "" : "s"}` : "defaults", tone: keymap.length > 0 ? "text" : "muted" },
    { label: "secrets", value: secrets.length > 0 ? secrets.join(", ") : "defaults", tone: secrets.length > 0 ? "text" : "muted" },
  ];
}

export function configExitText(cfg: DevctlConfig): string {
  if (cfg.shutdown.stop_services_on_exit === undefined) {
    return "ask on quit";
  }
  return cfg.shutdown.stop_services_on_exit ? "stop services" : "detach";
}

export function configServiceNameWidth(rows: readonly ConfigServiceRow[]): number {
  const longest = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
  return Math.min(CONFIG_NAME_MAX, Math.max(CONFIG_NAME_MIN, longest));
}

export const CONFIG_NAME_MIN = 8;
export const CONFIG_NAME_MAX = 20;
export const CONFIG_TWO_COL_MIN = 80;
export const CONFIG_FACT_LABEL = 10;

function tokenEndpointText(cfg: DevctlConfig): string {
  const endpoint = cfg.proxy.token_endpoint;
  if (!endpoint.enabled) {
    return "off";
  }
  const host = endpoint.host === "" ? "127.0.0.1" : endpoint.host;
  if (endpoint.port === 0) {
    return host;
  }
  return `${host}:${endpoint.port}`;
}

function routeMatchText(route: RouteConfig): string {
  const host = route.match.host || "*";
  const path = route.match.path;
  if (path === "") {
    return host;
  }
  return `${host}${path.startsWith("/") ? path : `/${path}`}`;
}

function routeIdentityText(route: RouteConfig): string {
  if (route.auth.identity.service_account !== "") {
    return route.auth.identity.service_account;
  }
  if (route.auth.service_account !== "") {
    return route.auth.service_account;
  }
  return route.auth.identity.type || "user";
}

function templateSummary(svc: ServiceConfig | undefined): string {
  if (!svc) {
    return "empty";
  }
  const parts: string[] = [];
  if (svc.health.type !== "") {
    parts.push(`health ${svc.health.type}`);
  }
  if (svc.restart.policy !== "") {
    parts.push(`restart ${svc.restart.policy}`);
  }
  if (svc.logs.stdout || svc.logs.stderr) {
    parts.push("logs");
  }
  return parts.join(" · ") || "empty";
}

