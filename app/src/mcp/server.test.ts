import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config/types.ts";
import { KindGeneral } from "../errors.ts";
import { emptyRuntime } from "../services.ts";
import { type StatusSnapshot } from "../types.ts";
import { isLoopbackHost, McpHttpServer } from "./server.ts";
import { type McpHost } from "./tools.ts";

function host(): McpHost {
  const cfg = defaultConfig();
  const snap: StatusSnapshot = {
    session_id: "s",
    repo_root: "/r",
    profile: "",
    services: { api: emptyRuntime("api") },
    proxy: { running: false },
    identity: { user: "", project: "", project_source: "", adc: false, service_accounts: {}, iap: false },
    logs: { total: 0, errors: 0, counts: {} },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
  return {
    status: () => snap,
    logs: () => [],
    config: () => cfg,
    start: async () => null,
    stop: async () => undefined,
    restart: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    doctor: async () => ({ checks: [], issues: 0 }),
  };
}

describe("mcp server", () => {
  test("refuses non-loopback bind", async () => {
    const server = new McpHttpServer({ host: "0.0.0.0", port: 18998, token: "t", hostApi: host() });
    await expect(server.start()).rejects.toMatchObject({ kind: KindGeneral });
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  test("requires bearer token and lists tools", async () => {
    const server = new McpHttpServer({ host: "127.0.0.1", port: 0, token: "sess", hostApi: host() });
    await server.start();
    const port = server.listenPort();
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(denied.status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sess" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools.some((tool) => tool.name === "list_services")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("emits lifecycle, connection, auth, and tool-call events", async () => {
    const events: Array<{ level: string; message: string }> = [];
    const server = new McpHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: "sess",
      hostApi: host(),
      onEvent: (level, message) => events.push({ level, message }),
    });
    await server.start();
    const port = server.listenPort();
    try {
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sess" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: { clientInfo: { name: "claude", version: "1.0" } },
        }),
      });
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sess" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_services", arguments: {} } }),
      });
    } finally {
      await server.stop();
    }
    expect(events.some((ev) => ev.level === "INFO" && ev.message.startsWith("listening on"))).toBe(true);
    expect(events.some((ev) => ev.level === "WARN" && ev.message.includes("unauthorized"))).toBe(true);
    expect(events.some((ev) => ev.level === "INFO" && ev.message.includes("client connected") && ev.message.includes("claude 1.0"))).toBe(true);
    expect(events.some((ev) => ev.level === "INFO" && ev.message.includes("tool call name=list_services"))).toBe(true);
    expect(events.some((ev) => ev.level === "INFO" && ev.message === "stopped")).toBe(true);
  });
});
