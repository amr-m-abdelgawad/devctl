import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../config/types.ts";
import { REDACTED_VALUE } from "../secrets.ts";
import { emptyRuntime, HealthHealthy, StateRunning } from "../services.ts";
import { type LogsRequest, type StatusSnapshot } from "../types.ts";
import { callMcpTool, MCP_LOG_CAP, type McpHost } from "./tools.ts";

function sampleSnap(): StatusSnapshot {
  const api = { ...emptyRuntime("api"), state: StateRunning, health: HealthHealthy, pid: 42, ports: { http: 9000 }, last_error: "" };
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
      iap: false,
    },
    logs: { total: 3, errors: 0, counts: { api: 3 } },
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
  const logs = [
    { timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "hello", pid: 1 },
    { timestamp: "t2", service: "api", source: "stdout", level: "ERROR", message: "Authorization: Bearer super-secret", pid: 1 },
    { timestamp: "t3", service: "worker", source: "stderr", level: "INFO", message: "tick", pid: 2 },
  ];
  return {
    status: () => sampleSnap(),
    logs: (req: LogsRequest) => {
      const wanted = req.services ?? [];
      return logs.filter((ev) => wanted.length === 0 || wanted.includes(ev.service));
    },
    config: () => cfg,
    start: async () => ({ started: true }),
    stop: async () => undefined,
    restart: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    doctor: async () => ({ checks: [{ name: "ok", severity: "ok", message: "fine" }], issues: 0 }),
  };
}

describe("mcp tools", () => {
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

  test("get_logs caps at 200", async () => {
    const host = stubHost();
    const many = Array.from({ length: MCP_LOG_CAP + 20 }, (_, i) => ({
      timestamp: String(i),
      service: "api",
      source: "stdout",
      level: "INFO",
      message: `line ${i}`,
      pid: 1,
    }));
    host.logs = () => many;
    const result = (await callMcpTool(host, "get_logs", {})) as { events: unknown[]; truncated: boolean };
    expect(result.events).toHaveLength(MCP_LOG_CAP);
    expect(result.truncated).toBe(true);
  });
});
