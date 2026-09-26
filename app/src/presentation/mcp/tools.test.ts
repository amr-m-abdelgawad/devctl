import { validateConfigText } from "../../adapters/config/index.ts";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyRouteAuth, emptyProfile, emptyService } from "../../domain/config/types.ts";
import { matchLog, type LogFilter, type LogPage, type LogPageRequest } from "../../adapters/storage/logs.ts";
import { logRecord } from "../../domain/logs/logs.ts";
import { REDACTED_VALUE } from "../../adapters/secrets/detector.ts";
import { emptyRuntime, HealthHealthy, StateRunning } from "../../domain/service/services.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { callMcpTool, isWebControlTool, iterateLogsExport, listServices, MCP_LOG_CAP, type McpHost } from "./tools.ts";

function sampleSnap(): StatusSnapshot {
  const api = emptyRuntime("api");
  api.state = StateRunning;
  api.health = HealthHealthy;
  api.pid = 42;
  api.ports = { http: 9000 };
  api.start_period_remaining_ms = 7_500;
  api.start_period_total_ms = 10_000;
  return {
    session_id: "sess",
    repo_root: "/repo",
    profile: "local",
    services: { api },
    proxy: { running: false, routes: [], requestTotal: 250, requestErrors: 4, recentRequests: [] },
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
    logs: { total: 3, errors: 0, counts: { api: 3 }, seen: 3, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
}

// A faithful-enough stand-in for LogManager.queryPage() — reuses the real
// matchLog() for filtering (services/level/search/source/since/until) and
// hand-implements only the seq-based cursor/direction/limit windowing, so
// getLogs()'s own request shaping and response handling can be tested
// against a bounded host without pulling in the real daemon-side log
// manager.
function fakeLogsPage(logs: ReturnType<typeof logRecord>[], req: LogFilter & LogPageRequest): LogPage {
  const matches = logs.filter((ev) => matchLog(req, ev));
  const limit = req.limit && req.limit > 0 ? req.limit : matches.length;
  const cursorSeq = req.cursor ? Number(req.cursor) : undefined;
  let windowed: ReturnType<typeof logRecord>[];
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

function fakeLogsStats(logs: ReturnType<typeof logRecord>[], req: LogFilter): { total: number; byService: Record<string, number>; byLevel: Record<string, number>; bySource: Record<string, number> } {
  const matches = logs.filter((ev) => matchLog(req, ev));
  const byService: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const ev of matches) {
    byService[ev.service] = (byService[ev.service] ?? 0) + 1;
    byLevel[ev.severityText] = (byLevel[ev.severityText] ?? 0) + 1;
    bySource[ev.source] = (bySource[ev.source] ?? 0) + 1;
  }
  return { total: matches.length, byService, byLevel, bySource };
}

function stubHost(): McpHost {
  const cfg = defaultConfig();
  cfg.repoRoot = "/repo";
  cfg.project.name = "demo";
  cfg.profiles = { local: emptyProfile({ services: ["api"] }) };
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
    logRecord({ timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "hello", pid: 1, seq: 1 }),
    logRecord({ timestamp: "t2", service: "api", source: "stdout", level: "ERROR", message: "Authorization: Bearer super-secret-token-value", pid: 1, seq: 2 }),
    logRecord({ timestamp: "t3", service: "worker", source: "stderr", level: "INFO", message: "tick", pid: 2, seq: 3 }),
  ];
  return {
    status: () => sampleSnap(),
    logsPage: (req: LogFilter & LogPageRequest) => fakeLogsPage(logs, req),
    logsStats: (req) => fakeLogsStats(logs, req),
    listLogSessions: () => ["session-one"],
    loadLogSession: (id) => (id === "session-one" ? logs : []),
    config: () => cfg,
    validateConfigText: (text) => validateConfigText(cfg.repoRoot, cfg.configPath, text),
    start: async () => ({ started: true }),
    stop: async () => undefined,
    restart: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    doctor: async () => ({ checks: [{ name: "ok", severity: "ok", message: "fine" }], issues: 0 }),
    exec: async (service, command, printEnv) => ({ service, code: 0, stdout: command.join(" ") + " Bearer super-secret-token-value", stderr: "", environment: printEnv ? { API_TOKEN: "secret-token", NAME: "ok" } : undefined }),
    runTask: async (name) => ({ task: name, code: 0, stdout: `ran ${name} Bearer super-secret-token-value`, stderr: "" }),
    startProxy: async () => undefined,
    stopProxy: async () => undefined,
    setServiceEnvironment: (service, name) => ({ service, env: name }),
    getPreferences: (scope) => ({
      values: {
        theme: "devctl",
        font_size: 14,
        mouse: true,
        leader_timeout: 2000,
        scroll_speed: 3,
        log_timestamps: true,
        log_metadata: true,
        web_appearance: "dark" as const,
        mcp_enabled: false,
      },
      scope: scope === "user" ? "user" : "repo",
      locked: false,
      paths: { user: "/u", repo: "/r", write: "/r", local: "/l" },
      layers: { theme: "default" as const },
      local: { web_enabled: false, web_port: 18900, inspect_max_bytes: 0 },
    }),
    setPreferences: async (patch) => ({
      values: {
        theme: patch.theme ?? "devctl",
        font_size: 14,
        mouse: true,
        leader_timeout: 2000,
        scroll_speed: 3,
        log_timestamps: true,
        log_metadata: true,
        web_appearance: "dark" as const,
        mcp_enabled: false,
      },
      scope: patch.scope === "user" ? "user" : "repo",
      locked: false,
      paths: { user: "/u", repo: "/r", write: "/r", local: "/l" },
      layers: { theme: "repo" as const },
      local: { web_enabled: patch.local?.web_enabled === true, web_port: patch.local?.web_port ?? 18900, inspect_max_bytes: patch.local?.inspect_max_bytes ?? 0 },
    }),
  };
}

describe("mcp tools", () => {
  test("exec_service is mutating and redacts output and resolved environment", async () => {
    const result = (await callMcpTool(stubHost(), "exec_service", { service: "api", command: ["echo", "ok"], print_env: true })) as { stdout: string; environment: Record<string, string> };
    expect(result.stdout).not.toContain("secret-token");
    expect(result.environment.API_TOKEN).toBe(REDACTED_VALUE);
    expect(result.environment.NAME).toBe("ok");
  });

  test("exec_service requires confirm: true to run a command", async () => {
    const host = stubHost();
    await expect(callMcpTool(host, "exec_service", { service: "api", command: ["echo", "ok"] })).rejects.toThrow("confirm: true");
    const result = (await callMcpTool(host, "exec_service", { service: "api", command: ["echo", "ok"], confirm: true })) as { stdout: string };
    expect(result.stdout).toContain("echo ok");
  });
  test("get_config exposes IAP client_id and never the client secret", async () => {
    const host = stubHost();
    const cfg = host.config();
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://billing.example.com" },
      auth: {
        ...emptyRouteAuth(),
        type: "iap",
        identity: { type: "user", service_account: "" },
        audience: "123.apps.googleusercontent.com",
        client_id: "desktop.apps.googleusercontent.com",
        client_secret: "inline-secret",
      },
    });
    const result = (await callMcpTool(host, "get_config", {})) as {
      proxy: { routes: Array<Record<string, unknown>> };
    };
    expect(result.proxy.routes[0]).toEqual({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: "https://billing.example.com",
      auth: "iap",
      identity: "user",
      audience: "123.apps.googleusercontent.com",
      client_id: "desktop.apps.googleusercontent.com",
    });
    expect(JSON.stringify(result)).not.toContain("inline-secret");
  });

  test("web control allows mutating tools except exec", async () => {
    expect(isWebControlTool("start_services")).toBe(true);
    expect(isWebControlTool("set_service_environment")).toBe(true);
    expect(isWebControlTool("stop_proxy")).toBe(true);
    expect(isWebControlTool("set_preferences")).toBe(true);
    expect(isWebControlTool("get_preferences")).toBe(false);
    expect(isWebControlTool("list_services")).toBe(false);
    expect(isWebControlTool("exec_service")).toBe(false);
  });

  test("get_preferences and set_preferences round-trip through the host", async () => {
    const got = (await callMcpTool(stubHost(), "get_preferences", { scope: "repo" })) as { scope: string; local: { web_port: number } };
    expect(got.scope).toBe("repo");
    expect(got.local.web_port).toBe(18900);
    const set = (await callMcpTool(stubHost(), "set_preferences", { scope: "user", theme: "nord" })) as { values: { theme: string }; scope: string };
    expect(set.scope).toBe("user");
    expect(set.values.theme).toBe("nord");
  });

  test("get_config shows an env-ref client_secret template and never a resolved secret", async () => {
    const host = stubHost();
    const cfg = host.config();
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://billing.example.com" },
      auth: {
        ...emptyRouteAuth(),
        type: "iap",
        identity: { type: "user", service_account: "" },
        audience: "123.apps.googleusercontent.com",
        client_id: "desktop.apps.googleusercontent.com",
        client_secret: "${IAP_OAUTH_CLIENT_SECRET}",
      },
    });
    const result = (await callMcpTool(host, "get_config", {})) as {
      proxy: { routes: Array<Record<string, unknown>> };
    };
    expect(result.proxy.routes[0]?.client_secret).toBe("${IAP_OAUTH_CLIENT_SECRET}");
    expect(JSON.stringify(result)).not.toContain("from-env");
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
      start_period_remaining_ms?: number;
      start_period_total_ms?: number;
    }>;
    expect(listed).toEqual([
      {
        name: "api",
        state: StateRunning,
        health: HealthHealthy,
        ports: { http: 9000 },
        pid: 42,
        last_error: "",
        start_period_remaining_ms: 7_500,
        start_period_total_ms: 10_000,
      },
    ]);
  });

  test("list_services includes named overlays when the service defines them", async () => {
    const host = stubHost();
    const svc = host.config().services.api!;
    svc.environments = {
      local: { vars: { MODE: "local" }, required: [], defaults: {} },
      deployed: { vars: { MODE: "deployed" }, required: [], defaults: {} },
    };
    const snap = host.status();
    snap.services.api!.env = "deployed";
    snap.services.api!.started_env = "local";
    const listed = listServices(snap, host.config()) as Array<{
      name: string;
      env?: string;
      started_env?: string;
      environments?: string[];
    }>;
    expect(listed[0]).toMatchObject({
      name: "api",
      env: "deployed",
      started_env: "local",
      environments: ["deployed", "local"],
    });
  });

  test("set_service_environment switches one service and can restart it", async () => {
    const host = stubHost();
    const svc = host.config().services.api!;
    svc.environments = {
      local: { vars: { MODE: "local" }, required: [], defaults: {} },
      deployed: { vars: { MODE: "deployed" }, required: [], defaults: {} },
    };
    const result = (await callMcpTool(host, "set_service_environment", { service: "api", name: "deployed", restart: true })) as { service: string; env: string; restarted: boolean };
    expect(result).toEqual({ service: "api", env: "deployed", restarted: true });
  });

  test("get_service redacts secret env", async () => {
    const svc = (await callMcpTool(stubHost(), "get_service", { name: "api" })) as {
      environment: Record<string, string>;
      command: string[];
      start_period_remaining_ms?: number;
      start_period_total_ms?: number;
    };
    expect(svc.command).toEqual(["bun", "run", "dev"]);
    expect(svc.environment.API_TOKEN).toBe(REDACTED_VALUE);
    expect(svc.environment.NAME).toBe("ok");
    expect(svc.start_period_remaining_ms).toBe(7_500);
    expect(svc.start_period_total_ms).toBe(10_000);
  });

  test("get_status omits session token", async () => {
    const status = (await callMcpTool(stubHost(), "get_status", {})) as {
      profile: string;
      mcp: { token?: string; running: boolean };
    };
    expect(status.profile).toBe("local");
    expect(status.mcp.running).toBe(true);
    expect(status.mcp.token).toBeUndefined();
    expect((status.mcp as { token_age_ms?: number }).token_age_ms).toBeUndefined();
  });

  test("get_logs parses dedupe_request_id", async () => {
    const host = stubHost();
    let seen: LogFilter | undefined;
    host.logsPage = (req) => {
      seen = req;
      return fakeLogsPage([], req);
    };
    await callMcpTool(host, "get_logs", { dedupe_request_id: true });
    expect(seen?.dedupeRequestId).toBe(true);
    await callMcpTool(host, "get_logs", {});
    expect(seen?.dedupeRequestId).toBe(false);
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

  test("get_logs honors limit, direction, regex, and returns prev_cursor", async () => {
    const host = stubHost();
    const many = Array.from({ length: 12 }, (_, i) => logRecord({
      timestamp: `t${i + 1}`,
      service: "api",
      source: "stdout",
      level: "INFO",
      message: i === 3 ? "error-line" : `line ${i + 1}`,
      pid: 1,
      seq: i + 1,
    }));
    host.logsPage = (req) => fakeLogsPage(many, req);
    const limited = (await callMcpTool(host, "get_logs", { limit: 5 })) as {
      events: Array<{ seq: number }>;
      prev_cursor: string;
      next_cursor: string;
      truncated: boolean;
    };
    expect(limited.events.map((ev) => ev.seq)).toEqual([8, 9, 10, 11, 12]);
    expect(limited.prev_cursor).toBe("8");
    expect(limited.next_cursor).toBe("12");
    expect(limited.truncated).toBe(true);

    const older = (await callMcpTool(host, "get_logs", { cursor: limited.prev_cursor, direction: "backward", limit: 5 })) as {
      events: Array<{ seq: number }>;
      prev_cursor: string;
    };
    expect(older.events.map((ev) => ev.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(older.prev_cursor).toBe("3");

    const regexed = (await callMcpTool(host, "get_logs", { search: "error-.*", regex: true })) as {
      events: Array<{ message: string }>;
    };
    expect(regexed.events.map((ev) => ev.message)).toEqual(["error-line"]);
    const literal = (await callMcpTool(host, "get_logs", { search: "error-.*", regex: false })) as {
      events: unknown[];
    };
    expect(literal.events).toEqual([]);
  });

  test("get_logs parses query-string booleans and numbers", async () => {
    const host = stubHost();
    let seen: LogFilter & LogPageRequest | undefined;
    host.logsPage = (req) => {
      seen = req;
      return fakeLogsPage([], req);
    };
    await callMcpTool(host, "get_logs", {
      limit: "25",
      direction: "backward",
      regex: "true",
      dedupe_request_id: "true",
      search: "err",
    });
    expect(seen?.limit).toBe(25);
    expect(seen?.direction).toBe("backward");
    expect(seen?.regex).toBe(true);
    expect(seen?.dedupeRequestId).toBe(true);
    expect(seen?.search).toBe("err");
  });

  test("get_log_stats returns facet counts without events", async () => {
    const stats = (await callMcpTool(stubHost(), "get_log_stats", { service: "api" })) as {
      total: number;
      byService: Record<string, number>;
      byLevel: Record<string, number>;
      events?: unknown;
    };
    expect(stats.total).toBe(2);
    expect(stats.byService).toEqual({ api: 2 });
    expect(stats.byLevel.ERROR).toBe(1);
    expect(stats.events).toBeUndefined();
  });

  test("iterateLogsExport streams redacted JSONL oldest-first across pages", async () => {
    const host = stubHost();
    const ev1 = logRecord({ timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "first", pid: 1, seq: 1 });
    const ev2 = logRecord({ timestamp: "t2", service: "api", source: "stdout", level: "INFO", message: "Authorization: Bearer super-secret-token-value", pid: 1, seq: 2 });
    host.logsPage = (req) => {
      if (!req.cursor) {
        return { events: [ev2], nextCursor: "2", prevCursor: "2", hasNext: false, hasPrev: true, sessionChanged: false };
      }
      if (req.direction === "backward") {
        return { events: [ev1], nextCursor: "1", prevCursor: "1", hasNext: true, hasPrev: false, sessionChanged: false };
      }
      return { events: [ev2], nextCursor: "2", prevCursor: "2", hasNext: false, hasPrev: true, sessionChanged: false };
    };
    const lines: string[] = [];
    for await (const line of iterateLogsExport(host, {})) {
      lines.push(line);
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines.join("\n")).not.toContain("super-secret");
    expect(JSON.parse(lines[0] as string).seq).toBe(1);
    expect(JSON.parse(lines[1] as string).seq).toBe(2);
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
    expect(seen).toEqual({ services: [], profile: undefined });
  });

  test("run_task redacts stdout and start_proxy/stop_proxy call the host", async () => {
    const host = stubHost();
    let proxy = "idle";
    host.startProxy = async () => {
      proxy = "started";
    };
    host.stopProxy = async () => {
      proxy = "stopped";
    };
    const task = (await callMcpTool(host, "run_task", { name: "seed" })) as { task: string; stdout: string };
    expect(task.task).toBe("seed");
    expect(task.stdout).not.toContain("secret-token");
    await callMcpTool(host, "start_proxy", {});
    expect(proxy).toBe("started");
    await callMcpTool(host, "stop_proxy", {});
    expect(proxy).toBe("stopped");
  });

  test("get_logs caps at 200", async () => {
    const host = stubHost();
    const many = Array.from({ length: MCP_LOG_CAP + 20 }, (_, i) => logRecord({
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

  test("get_logs returns body attributes and severityNumber", async () => {
    const result = (await callMcpTool(stubHost(), "get_logs", { service: "api" })) as {
      events: Array<{ body: unknown; attributes: Record<string, unknown>; severityNumber: number; traceId?: string }>;
    };
    expect(result.events[0]?.body).toBe("hello");
    expect(result.events[0]?.severityNumber).toBeGreaterThan(0);
  });

  test("get_trace and trace_request return a redacted span tree", async () => {
    const host = stubHost();
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    host.getTrace = async (id) => ({
      traceId: id,
      tree: {
        traceId: id,
        spans: [{
          seq: 1,
          traceId: id,
          spanId: "bbbbbbbbbbbbbbbb",
          name: "GET /",
          kind: "server",
          startUnixNano: 1,
          endUnixNano: 2,
          status: { code: "ok" },
          attributes: { "http.request.method": "GET", token: "super-secret-token-value" },
          events: [],
          links: [],
          resource: { "service.name": "proxy" },
        }],
        roots: [],
      },
      events: [logRecord({ service: "api", message: "Authorization: Bearer super-secret-token-value", traceId: id, seq: 1 })],
    });
    host.traceRequest = async (requestId) => ({ ...(await host.getTrace!(traceId)), requestId });
    const byTrace = (await callMcpTool(host, "get_trace", { trace_id: traceId })) as {
      trace_id: string;
      spans: Array<{ attributes: Record<string, unknown> }>;
      logs: Array<{ message: string }>;
    };
    expect(byTrace.trace_id).toBe(traceId);
    expect(byTrace.spans).toHaveLength(1);
    expect(JSON.stringify(byTrace.spans)).not.toContain("super-secret");
    expect(byTrace.logs[0]?.message).not.toContain("super-secret");
    const byReq = (await callMcpTool(host, "trace_request", { request_id: "caller-id" })) as { request_id: string };
    expect(byReq.request_id).toBe("caller-id");
  });

  test("get_llm_calls and get_llm_call redact secrets and omit bodies on the list", async () => {
    const host = stubHost();
    const call = {
      seq: 1,
      id: "chatcmpl-secret",
      source: "platform",
      sourceType: "litellm",
      timestamp: "2026-01-01T00:00:00.000Z",
      status: "ok" as const,
      model: "gpt-4o",
      operation: "chat" as const,
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      cost: 0.01,
      request: { messages: [{ role: "user", content: "Authorization: Bearer super-secret-token-value" }] },
      response: { choices: [{ message: { content: "ok" } }] },
      attributes: { token: "super-secret-token-value" },
    };
    host.llmCallsPage = () => ({
      calls: [call],
      nextCursor: "next",
      hasNext: false,
      errors: [],
    });
    host.getLlmCall = (id) => (id === call.id ? call : undefined);
    const page = (await callMcpTool(host, "get_llm_calls", {})) as {
      calls: Array<{ id: string; request?: unknown; attributes: Record<string, unknown> }>;
    };
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.id).toBe(call.id);
    expect(page.calls[0]?.request).toBeUndefined();
    expect(JSON.stringify(page.calls)).not.toContain("super-secret");
    const detail = (await callMcpTool(host, "get_llm_call", { id: call.id })) as {
      request: unknown;
      attributes: Record<string, unknown>;
    };
    expect(JSON.stringify(detail)).not.toContain("super-secret");
    expect(JSON.stringify(detail.request)).toContain(REDACTED_VALUE);
  });

  test("get_traffic_calls omits bodies and get_traffic_call redacts them", async () => {
    const host = stubHost();
    const call = {
      seq: 1,
      id: "req-secret",
      timestamp: "2026-01-01T00:00:00.000Z",
      method: "POST",
      path: "/invoices",
      route: "invoices-api",
      transport: "http" as const,
      callerEmail: "accounts.google.com:dev@example.com",
      status: 200,
      request: { text: '{"token":"super-secret-token-value"}', encoding: "utf8" as const },
      response: { text: '{"ok":true}', encoding: "utf8" as const },
      attributes: { token: "super-secret-token-value" },
    };
    host.trafficCallsPage = () => ({
      calls: [call],
      nextCursor: "next",
      hasNext: false,
    });
    host.getTrafficCall = (id) => (id === call.id ? call : undefined);
    const page = (await callMcpTool(host, "get_traffic_calls", {})) as {
      calls: Array<{ id: string; caller_email?: string; request?: unknown; attributes: Record<string, unknown> }>;
    };
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.id).toBe(call.id);
    expect(page.calls[0]?.caller_email).toBe("accounts.google.com:dev@example.com");
    expect(page.calls[0]?.request).toBeUndefined();
    expect(JSON.stringify(page.calls)).not.toContain("super-secret");
    const detail = (await callMcpTool(host, "get_traffic_call", { id: call.id })) as {
      request: unknown;
      attributes: Record<string, unknown>;
    };
    expect(JSON.stringify(detail)).not.toContain("super-secret");
    expect(JSON.stringify(detail.request)).toContain(REDACTED_VALUE);
  });

  test("get_requests marks a hop captured when a traffic call exists", async () => {
    const host = stubHost();
    const snap = sampleSnap();
    snap.proxy.recentRequests = [{
      timestamp: "2026-01-01T00:00:00.000Z",
      requestId: "req-1",
      method: "GET",
      path: "/invoices",
      route: "invoices-api",
      identity: "user",
      status: 200,
      durationMs: 4,
    }];
    host.status = () => snap;
    host.getTrafficCall = (id) => (id === "req-1" ? {
      seq: 1,
      id: "req-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      method: "GET",
      path: "/invoices",
      route: "invoices-api",
      transport: "http",
      status: 200,
      attributes: {},
    } : undefined);
    const requests = (await callMcpTool(host, "get_requests", {})) as { requests: Array<{ request_id: string; captured: boolean }> };
    expect(requests.requests[0]?.captured).toBe(true);
  });

  test("get_requests and recent_errors use status and error logs", async () => {
    const host = stubHost();
    const requests = (await callMcpTool(host, "get_requests", {})) as { total: number; errors: number; requests: unknown[] };
    expect(requests.total).toBe(250);
    expect(requests.errors).toBe(4);
    expect(requests.requests).toEqual([]);
    const errors = (await callMcpTool(host, "recent_errors", {})) as { events: Array<{ service: string; severityText: string }> };
    expect(errors.events.every((ev) => ev.severityText === "ERROR" || ev.severityText === "FATAL")).toBe(true);
    expect(errors.events.some((ev) => ev.service === "api")).toBe(true);
  });
});
