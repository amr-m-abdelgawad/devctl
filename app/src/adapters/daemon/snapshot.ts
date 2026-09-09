import { cpus, loadavg, platform, uptime } from "node:os";
import type { DevctlConfig } from "../config/index.ts";
import { configuredServiceAccounts } from "../../domain/identity/identity.ts";
import { displayState, type Runtime } from "../../domain/service/services.ts";
import type { IdentitySnapshot, ServiceAccountStatus, StatsSeries, StatusSnapshot, SystemSnapshot } from "../../domain/status.ts";
import type { McpListener } from "../../ports/mcp-host.ts";
import { readHostMemory } from "../system/host-stats.ts";
import type { ProxyServer } from "../proxy/proxy.ts";

export type SnapshotHost = {
  readonly sessionID: string;
  readonly cfg: DevctlConfig;
  readonly profile: string;
  readonly runtimes: Map<string, Runtime>;
  readonly ports: Map<string, Record<string, number>>;
  readonly serviceProfile: Map<string, string>;
  readonly clientEnv: Map<string, Record<string, string>>;
  readonly proxy?: ProxyServer;
  readonly mcp?: McpListener;
  readonly mcpToken: string;
  readonly mcpDisabledTools: string[];
  readonly identityCache: IdentitySnapshot;
  readonly serviceAccountStatus: Map<string, ServiceAccountStatus>;
  readonly credentialEntries: Array<{ identity: string; audience: string; expires_at: string; valid: boolean }>;
  readonly detached: boolean;
  readonly setupMode: boolean;
  readonly restartRequired: string[];
  readonly statsSeries?: StatsSeries;
  readonly logs: { snapshot(): { total: number; errors: number; counts: Record<string, number> } };
  readonly tokens: { storeBackend(): string };
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

export function buildSnapshot(host: SnapshotHost): StatusSnapshot {
  const services: Record<string, Runtime> = {};
  for (const [name, rt] of host.runtimes) {
    services[name] = {
      ...rt,
      ports: host.ports.get(name) ?? rt.ports,
      profile: host.serviceProfile.get(name) ?? rt.profile,
      env_source: host.clientEnv.has(name) ? "client" : "daemon",
    };
  }
  const proxyStatsRaw = host.proxy?.stats();
  const proxyStats = {
    requestTotal: proxyStatsRaw?.total ?? 0,
    requestErrors: proxyStatsRaw?.errors ?? 0,
    recentRequests: proxyStatsRaw?.recent ?? [],
  };
  return {
    session_id: host.sessionID,
    repo_root: host.cfg.repoRoot,
    profile: host.profile,
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
        };
      }),
      ...proxyStats,
    },
    mcp: {
      running: host.mcp?.isRunning() ?? false,
      address: host.mcp?.isRunning() ? `http://${host.mcp.address()}/mcp` : undefined,
      port: host.mcp?.isRunning() ? host.mcp.listenPort() : undefined,
      token: host.mcpToken,
      disabled_tools: [...host.mcpDisabledTools],
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
  };
}

export function formatStatusFromSnapshot(snap: StatusSnapshot): string {
  const lines = [`PROFILE: ${snap.profile || "(none)"}`, "", "SERVICE\tSTATUS\tHEALTH\tPID"];
  for (const [name, rt] of Object.entries(snap.services)) {
    lines.push(`${name}\t${displayState(rt)}\t${rt.health}\t${rt.pid}`);
  }
  lines.push("", `PROXY       ${snap.proxy.running ? "RUNNING" : "STOPPED"}     ${snap.proxy.address ?? ""}`);
  lines.push(`MCP         ${snap.mcp?.running ? "RUNNING" : "STOPPED"}     ${snap.mcp?.address ?? ""}`);
  return lines.join("\n") + "\n";
}
