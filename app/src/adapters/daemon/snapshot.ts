import { readFileSync } from "node:fs";
import { cpus, loadavg, platform, uptime } from "node:os";
import type { DevctlConfig } from "../config/index.ts";
import { inspectIapOAuthClientFile } from "../../domain/config/iap-credentials.ts";
import { envRefsIn } from "../../domain/config/env-ref.ts";
import type { RouteAuthConfig } from "../../domain/config/types.ts";
import { configuredServiceAccounts } from "../../domain/identity/identity.ts";
import { displayState, startPeriodWindow, type Runtime } from "../../domain/service/services.ts";
import { defaultEnvironmentName, resolveEnvironmentName } from "../../domain/service/environments.ts";
import { instanceStatusLine, type IdentitySnapshot, type LogSnapshot, type ServiceAccountStatus, type StatsSeries, type StatusSnapshot, type SystemSnapshot } from "../../domain/status.ts";
import type { McpListener } from "../../ports/mcp-host.ts";
import type { WebListener } from "../../ports/web-host.ts";
import { readHostMemory } from "../system/host-stats.ts";
import type { ProxyServer } from "../proxy/proxy.ts";

export type SnapshotHost = {
  readonly sessionID: string;
  readonly cfg: DevctlConfig;
  readonly profile: string;
  readonly runtimes: Map<string, Runtime>;
  readonly ports: Map<string, Record<string, number>>;
  readonly serviceProfile: Map<string, string>;
  readonly serviceEnv: Map<string, string>;
  readonly serviceStartedEnv: Map<string, string>;
  readonly clientEnv: Map<string, Record<string, string>>;
  readonly proxy?: ProxyServer;
  readonly mcp?: McpListener;
  readonly web?: WebListener;
  readonly mcpToken: string;
  readonly mcpTokenAgeMs?: number;
  readonly mcpDisabledTools: string[];
  readonly identityCache: IdentitySnapshot;
  readonly serviceAccountStatus: Map<string, ServiceAccountStatus>;
  readonly credentialEntries: Array<{ identity: string; audience: string; expires_at: string; valid: boolean }>;
  readonly detached: boolean;
  readonly setupMode: boolean;
  readonly restartRequired: string[];
  readonly statsSeries?: StatsSeries;
  readonly serviceSeries?: Record<string, StatsSeries>;
  readonly logs: { snapshot(): LogSnapshot };
  readonly tokens: { storeBackend(): string };
  readonly traceDurationMs?: (traceId: string) => number | undefined;
};

export function emptyIdentitySnapshot(cfg?: DevctlConfig): IdentitySnapshot {
  return {
    user: "",
    project: cfg?.google.project_id ?? "",
    project_source: cfg?.google.project_id ? "configuration" : "",
    adc: false,
    // Nothing has been probed yet — omitted here, not defaulted to false;
    // see service_account_status for the "not probed yet" state itself.
    service_accounts: {},
    service_account_status: Object.fromEntries(cfg ? configuredServiceAccounts(cfg).map((email) => [email, "unknown" as const]) : []),
    iap: cfg?.proxy.routes.some((route) => route.auth.type.toLowerCase() === "iap") ?? false,
  };
}

export function systemSnapshot(): SystemSnapshot {
  const avg = loadavg();
  const mem = readHostMemory();
  return {
    platform: platform(),
    cpuCount: cpus().length,
    loadAvg1: avg[0] ?? 0,
    loadAvg5: avg[1] ?? 0,
    loadAvg15: avg[2] ?? 0,
    memTotalKB: mem.totalKB,
    memFreeKB: mem.unusedKB,
    memAvailableKB: mem.leftoverKB,
    hostUptimeSec: uptime(),
  };
}

export function serviceAccountSnapshot(
  cfg: DevctlConfig,
  serviceAccountStatus: Map<string, ServiceAccountStatus>,
): { service_accounts: Record<string, boolean>; service_account_status: Record<string, ServiceAccountStatus> } {
  const service_accounts: Record<string, boolean> = {};
  const service_account_status: Record<string, ServiceAccountStatus> = {};
  for (const email of configuredServiceAccounts(cfg)) {
    const status = serviceAccountStatus.get(email) ?? "unknown";
    service_account_status[email] = status;
    if (status !== "unknown") {
      service_accounts[email] = status === "available";
    }
  }
  return { service_accounts, service_account_status };
}

export function buildSnapshot(host: SnapshotHost, nowMs = Date.now()): StatusSnapshot {
  const services: Record<string, Runtime> = {};
  for (const [name, rt] of host.runtimes) {
    const window = startPeriodWindow(rt.startTime, host.cfg.services[name]?.health.start_period_seconds ?? 0, nowMs);
    services[name] = {
      ...rt,
      ports: host.ports.get(name) ?? rt.ports,
      profile: host.serviceProfile.get(name) ?? rt.profile,
      env_source: host.clientEnv.has(name) ? "client" : "daemon",
      env: selectedEnvName(host, name),
      started_env: host.serviceStartedEnv.get(name) ?? rt.started_env,
      start_period_remaining_ms: window.remainingMs,
      start_period_total_ms: window.totalMs,
    };
  }
  const proxyStatsRaw = host.proxy?.stats();
  const proxyStats = {
    requestTotal: proxyStatsRaw?.total ?? 0,
    requestErrors: proxyStatsRaw?.errors ?? 0,
    recentRequests: (proxyStatsRaw?.recent ?? []).map((req) => ({
      ...req,
      traceDurationMs: req.traceId && host.traceDurationMs ? host.traceDurationMs(req.traceId) : undefined,
    })),
  };
  return {
    session_id: host.sessionID,
    repo_root: host.cfg.repoRoot,
    profile: host.profile,
    instance: { name: host.cfg.instance.name, slot: host.cfg.instance.slot, port_offset: host.cfg.instance.portOffset },
    services,
    proxy: {
      running: host.proxy?.isRunning() ?? false,
      address: host.proxy?.address(),
      routes: host.cfg.proxy.routes.map((r) => {
        const hostMatch = r.match.host || "*";
        const path = r.match.path;
        const match = path === "" ? hostMatch : `${hostMatch}${path.startsWith("/") ? path : `/${path}`}`;
        return {
          name: r.name,
          identity: r.auth.identity.service_account || r.auth.identity.type || r.auth.type,
          upstream: r.upstream.url,
          auth: r.auth.type,
          match,
          client_id: r.auth.client_id.trim() || undefined,
          credentials_valid: routeIapCredentialsValid(r.auth),
        };
      }),
      ...proxyStats,
    },
    mcp: {
      running: host.mcp?.isRunning() ?? false,
      address: host.mcp?.isRunning() ? `http://${host.mcp.address()}/mcp` : undefined,
      port: host.mcp?.isRunning() ? host.mcp.listenPort() : undefined,
      token: host.mcpToken,
      token_age_ms: host.mcpTokenAgeMs,
      disabled_tools: [...host.mcpDisabledTools],
    },
    web: {
      running: host.web?.isRunning() ?? false,
      address: host.web?.isRunning() ? `http://${host.web.address()}/` : undefined,
      port: host.web?.isRunning() ? host.web.listenPort() : undefined,
    },
    // service_accounts/service_account_status come from the live cache,
    // not identityCache's snapshot — a first-use probe (startOne) or a
    // doctor inspection updates serviceAccountStatus directly without
    // going through refreshIdentity, and must be visible immediately.
    identity: { ...host.identityCache, ...serviceAccountSnapshot(host.cfg, host.serviceAccountStatus) },
    credentials: {
      backend: host.tokens.storeBackend(),
      entries: [...host.credentialEntries],
    },
    detached: host.detached,
    setup_mode: host.setupMode ? true : undefined,
    logs: host.logs.snapshot(),
    restart_required: [...host.restartRequired],
    system: systemSnapshot(),
    stats_series: host.statsSeries,
    // Omit until at least one service has samples, so consumers can tell an
    // unavailable series from an empty service set (matches the type contract).
    service_series: host.serviceSeries && Object.keys(host.serviceSeries).length > 0 ? host.serviceSeries : undefined,
  };
}

export function routeIapCredentialsValid(auth: RouteAuthConfig): boolean | undefined {
  if (auth.type.toLowerCase() !== "iap") {
    return undefined;
  }
  const path = (auth.credentials ?? "").trim();
  if (path === "" || envRefsIn(path).length > 0) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return inspectIapOAuthClientFile(parsed, auth.client_id).ok;
}

function selectedEnvName(host: SnapshotHost, name: string): string {
  const svc = host.cfg.services[name];
  if (!svc) {
    return host.serviceEnv.get(name) ?? "";
  }
  return resolveEnvironmentName(svc, host.serviceEnv.get(name) ?? defaultEnvironmentName(svc));
}

export function formatStatusFromSnapshot(snap: StatusSnapshot): string {
  const lines = [`PROFILE: ${snap.profile || "(none)"}`];
  const instanceLine = instanceStatusLine(snap.instance);
  if (instanceLine !== undefined) {
    lines.push(instanceLine);
  }
  lines.push("", "SERVICE\tSTATUS\tHEALTH\tENV\tPID");
  for (const [name, rt] of Object.entries(snap.services)) {
    lines.push(`${name}\t${displayState(rt)}\t${rt.health}\t${rt.env || ""}\t${rt.pid}`);
  }
  lines.push("", `PROXY       ${snap.proxy.running ? "RUNNING" : "STOPPED"}     ${snap.proxy.address ?? ""}`);
  lines.push(`MCP         ${snap.mcp?.running ? "RUNNING" : "STOPPED"}     ${snap.mcp?.address ?? ""}`);
  lines.push(`WEB         ${snap.web?.running ? "RUNNING" : "STOPPED"}     ${snap.web?.address ?? ""}`);
  return lines.join("\n") + "\n";
}
