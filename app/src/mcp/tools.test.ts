import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../config/types.ts";
import { matchLog, type LogEvent, type LogFilter, type LogPage, type LogPageRequest } from "../logs.ts";
import { REDACTED_VALUE } from "../secrets.ts";
import { emptyRuntime, HealthHealthy, StateRunning } from "../services.ts";
import { type StatusSnapshot } from "../types.ts";
import { callMcpTool, MCP_LOG_CAP, type McpHost } from "./tools.ts";

function sampleSnap(): StatusSnapshot {
  const api = emptyRuntime("api");
  api.state = StateRunning;
  api.health = HealthHealthy;
  api.pid = 42;
  api.ports = { http: 9000 };
  return {
    session_id: "sess",
    repo_root: "/repo",
    profile: "local",
    services: { api },
    proxy: { running: false, routes: [] },
    mcp: { running: true, address: "http://127.0.0.1:18721/mcp", port: 18721, token: "secret-session" },
    identity: {
      user: "dev@example.com",
      project: "demo",
      project_source: "configuration",
      adc: true,
      service_accounts: {},
      service_account_status: {},
      iap: false,
    },
    logs: { total: 3, errors: 0, counts: { api: 3 } },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
}

// A faithful-enough stand-in for LogManager.queryPage() — reuses the real
// matchLog() for filtering (services/level/search/source/since/until) and
// hand-implements only the seq-based cursor/direction/limit windowing, so
// getLogs()'s own request shaping and response handling can be tested
// against a bounded host without pulling in the real daemon-side log
// manager.
function fakeLogsPage(logs: LogEvent[], req: LogFilter & LogPageRequest): LogPage {
  const matches = logs.filter((ev) => matchLog(req, ev));
  const limit = req.limit && req.limit > 0 ? req.limit : matches.length;
  const cursorSeq = req.cursor ? Number(req.cursor) : undefined;
  let windowed: LogEvent[];
  if (cursorSeq === undefined) {
    windowed = matches.slice(Math.max(0, matches.length - limit));
  } else if (req.direction === "forward") {
    windowed = matches.filter((ev) => ev.seq > cursorSeq).slice(0, limit);
  } else {
    const before = matches.filter((ev) => ev.seq < cursorSeq);
    windowed = before.slice(Math.max(0, before.length - limit));
  }
  const firstSeq = windowed[0]?.seq;
  const lastSeq = windowed[windowed.length - 1]?.seq;
  return {
    events: windowed,
    nextCursor: String(lastSeq ?? cursorSeq ?? 0),
    prevCursor: String(firstSeq ?? cursorSeq ?? 0),
    hasNext: lastSeq !== undefined && matches.some((ev) => ev.seq > lastSeq),
    hasPrev: firstSeq !== undefined && matches.some((ev) => ev.seq < firstSeq),
    sessionChanged: false,
  };
}

function stubHost(): McpHost {
  const cfg = defaultConfig();
  cfg.repoRoot = "/repo";
  cfg.project.name = "demo";
  cfg.profiles = { local: { services: ["api"], environment: {} } };
  const svc = emptyService();
  svc.command = { args: ["bun", "run", "dev"], shell: false };
  svc.working_dir = "api";
  svc.environment.vars = { API_TOKEN: "super-secret", NAME: "ok" };
  cfg.services.api = svc;
  cfg.provenance["services.api.environment.API_TOKEN"] = [
    { source: "/repo/.devctl/config.yaml", layer: "main" },
    { source: "/repo/.devctl/config.local.yaml", layer: "repo_local" },
  ];
  const logs = [
    { timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "hello", pid: 1, seq: 1 },
    { timestamp: "t2", service: "api", source: "stdout", level: "ERROR", message: "Authorization: Bearer super-secret", pid: 1, seq: 2 },
    { timestamp: "t3", service: "worker", source: "stderr", level: "INFO", message: "tick", pid: 2, seq: 3 },
  ];
  return {
    status: () => sampleSnap(),
    logsPage: (req: LogFilter & LogPageRequest) => fakeLogsPage(logs, req),
    config: () => cfg,
    start: async () => ({ started: true }),
    stop: async () => undefined,
    restart: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    doctor: async () => ({ checks: [{ name: "ok", severity: "ok", message: "fine" }], issues: 0 }),
    exec: async (service, command, printEnv) => ({ service, code: 0, stdout: command.join(" ") + " Bearer secret-token", stderr: "", environment: printEnv ? { API_TOKEN: "secret-token", NAME: "ok" } : undefined }),
  };
}

describe("mcp tools", () => {
  test("exec_service is mutating and redacts output and resolved environment", async () => {
    const result = (await callMcpTool(stubHost(), "exec_service", { service: "api", command: ["echo", "ok"], print_env: true })) as { stdout: string; environment: Record<string, string> };
    expect(result.stdout).not.toContain("secret-token");
    expect(result.environment.API_TOKEN).toBe(REDACTED_VALUE);
    expect(result.environment.NAME).toBe("ok");
  });
  test("get_config_sources returns provenance while redacting secret values", async () => {
    const result = (await callMcpTool(stubHost(), "get_config_sources", {})) as { entries: Array<{ value: string; layer: string; shadowed: unknown[] }> };
    expect(result.entries[0]?.value).toBe(REDACTED_VALUE);
    expect(result.entries[0]?.layer).toBe("repo_local");
    expect(result.entries[0]?.shadowed).toHaveLength(1);
  });

  test("list_services returns runtime fields", async () => {
    const listed = (await callMcpTool(stubHost(), "list_services", {})) as Array<{
      name: string;
      state: string;
      health: string;
      ports: Record<string, number>;
      pid: number;
      last_error: string;
    }>;
    expect(listed).toEqual([
      { name: "api", state: StateRunning, health: HealthHealthy, ports: { http: 9000 }, pid: 42, last_error: "" },
    ]);
  });

  test("get_service redacts secret env", async () => {
    const svc = (await callMcpTool(stubHost(), "get_service", { name: "api" })) as {
      environment: Record<string, string>;
      command: string[];
    };
    expect(svc.command).toEqual(["bun", "run", "dev"]);
    expect(svc.environment.API_TOKEN).toBe(REDACTED_VALUE);
    expect(svc.environment.NAME).toBe("ok");
  });

  test("get_status omits session token", async () => {
    const status = (await callMcpTool(stubHost(), "get_status", {})) as {
      profile: string;
      mcp: { token?: string; running: boolean };
    };
    expect(status.profile).toBe("local");
    expect(status.mcp.running).toBe(true);
    expect(status.mcp.token).toBeUndefined();
  });

  test("get_logs filters by service and redacts", async () => {
    const result = (await callMcpTool(stubHost(), "get_logs", { service: "api" })) as {
      events: Array<{ service: string; message: string }>;
    };
    expect(result.events).toHaveLength(2);
    expect(result.events.every((ev) => ev.service === "api")).toBe(true);
    expect(result.events[1]?.message).not.toContain("super-secret");
  });

  test("get_logs since/until are plain inclusive timestamp filters, not a follow cursor", async () => {
    const result = (await callMcpTool(stubHost(), "get_logs", { since: "t2" })) as {
      events: Array<{ timestamp: string }>;
    };
    // Inclusive, same as CLI/TUI's own since filter — unlike the old
    // next_since-as-resume convention, this makes no attempt to exclude the
    // boundary event itself; that correctness now belongs to cursor.
    expect(result.events.map((ev) => ev.timestamp)).toEqual(["t2", "t3"]);
    const bounded = (await callMcpTool(stubHost(), "get_logs", { since: "t1", until: "t2" })) as {
      events: Array<{ timestamp: string }>;
    };
    expect(bounded.events.map((ev) => ev.timestamp)).toEqual(["t1", "t2"]);
  });

  test("get_logs cursor pages forward without repeating or losing events", async () => {
    const host = stubHost();
    const first = (await callMcpTool(host, "get_logs", {})) as {
      events: Array<{ timestamp: string }>;
      next_cursor: string;
    };
    expect(first.events.map((ev) => ev.timestamp)).toEqual(["t1", "t2", "t3"]);
    const followed = (await callMcpTool(host, "get_logs", { cursor: first.next_cursor })) as {
      events: unknown[];
      next_cursor: string;
    };
    expect(followed.events).toEqual([]);
    expect(followed.next_cursor).toBe(first.next_cursor);
  });

  test("get_logs surfaces a stale cursor from a different daemon session", async () => {
    const host = stubHost();
    host.logsPage = async () => ({
      events: [],
      nextCursor: "c",
      prevCursor: "c",
      hasNext: false,
      hasPrev: false,
      sessionChanged: true,
    });
    const result = (await callMcpTool(host, "get_logs", { cursor: "stale" })) as { session_changed: boolean };
    expect(result.session_changed).toBe(true);
  });

  test("start_services forwards profile and does not invent a service list", async () => {
    const host = stubHost();
    let seen: { services?: string[]; profile?: string } | undefined;
    host.start = async (req) => {
      seen = req;
      return { started: true };
    };
    await callMcpTool(host, "start_services", { profile: "backend" });
    expect(seen).toEqual({ services: [], profile: "backend" });
    await callMcpTool(host, "start_services", {});
    expect(seen).toEqual({ services: [], profile: "" });
  });

  test("get_logs caps at 200", async () => {
    const host = stubHost();
    const many: LogEvent[] = Array.from({ length: MCP_LOG_CAP + 20 }, (_, i) => ({
      timestamp: String(i),
      service: "api",
      source: "stdout",
      level: "INFO",
      message: `line ${i}`,
      pid: 1,
      seq: i + 1,
    }));
    host.logsPage = (req) => fakeLogsPage(many, req);
    const result = (await callMcpTool(host, "get_logs", {})) as { events: unknown[]; truncated: boolean; has_more: boolean };
    expect(result.events).toHaveLength(MCP_LOG_CAP);
    expect(result.truncated).toBe(true);
    expect(result.has_more).toBe(false);
  });
});
