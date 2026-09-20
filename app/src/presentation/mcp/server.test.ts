import { request as httpRequest } from "node:http";
import { validateConfigText } from "../../adapters/config/index.ts";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { KindGeneral } from "../../shared/errors.ts";
import { emptyRuntime } from "../../domain/service/services.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { isLoopbackHost, McpHttpServer } from "./server.ts";
import { MCP_TOOLS } from "./tools.ts";
import { type McpHost } from "./tools.ts";

function host(): McpHost {
  const cfg = defaultConfig();
  const snap: StatusSnapshot = {
    session_id: "s",
    repo_root: "/r",
    profile: "",
    services: { api: emptyRuntime("api") },
    proxy: { running: false },
    identity: { user: "", project: "", project_source: "", adc: false, service_accounts: {}, service_account_status: {}, iap: false },
    logs: { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
  return {
    status: () => snap,
    logsPage: () => ({ events: [], nextCursor: "", prevCursor: "", hasNext: false, hasPrev: false, sessionChanged: false }),
    logsStats: () => ({ total: 0, byService: {}, byLevel: {}, bySource: {} }),
    listLogSessions: () => [],
    loadLogSession: () => [],
    config: () => cfg,
    validateConfigText: (text) => validateConfigText(cfg.repoRoot, cfg.configPath, text),
    start: async () => null,
    stop: async () => undefined,
    restart: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    doctor: async () => ({ checks: [], issues: 0 }),
    runTask: async (name) => ({ task: name, code: 0, stdout: "", stderr: "" }),
    startProxy: async () => undefined,
    stopProxy: async () => undefined,
  };
}

function rawRequest(port: number, opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: opts.path,
      method: opts.method ?? "GET",
      headers: opts.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

describe("mcp server", () => {
  test("refuses non-loopback bind", async () => {
    const server = new McpHttpServer({ host: "0.0.0.0", port: 18998, token: "t", hostApi: host() });
    await expect(server.start()).rejects.toMatchObject({ kind: KindGeneral });
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
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
      expect(ok.headers.get("access-control-allow-origin")).toBeNull();
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

  test("rejects an oversized POST body", async () => {
    const server = new McpHttpServer({ host: "127.0.0.1", port: 0, token: "sess", hostApi: host() });
    await server.start();
    const port = server.listenPort();
    const body = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${"x".repeat(1024 * 1024)}"}`;
    try {
      const oversized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sess" },
        body,
      });
      expect(oversized.status).toBe(413);
      const payload = (await oversized.json()) as { error: { code: number; message: string } };
      expect(payload.error.code).toBe(-32700);
      expect(payload.error.message).toBe("payload too large");
    } finally {
      await server.stop();
    }
  });

  test("rejects a spoofed Host and does not advertise CORS", async () => {
    const server = new McpHttpServer({ host: "127.0.0.1", port: 0, token: "sess", hostApi: host() });
    await server.start();
    const port = server.listenPort();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    try {
      const spoofed = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        headers: {
          Host: "evil.example:80",
          "Content-Type": "application/json",
          Authorization: "Bearer sess",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(spoofed.status).toBe(403);

      const preflight = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(preflight.status).toBe(405);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(preflight.headers.get("allow")).toBe("POST");
    } finally {
      await server.stop();
    }
  });
});

describe("disabled tools", () => {
  function serverWith(disabled: string[]): { srv: McpHttpServer; call: (m: string, p?: unknown) => Promise<Record<string, unknown>> } {
    const srv = new McpHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: "",
      hostApi: { config: () => defaultConfig() } as never,
      disabledTools: () => disabled,
    });
    const call = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
      (srv as unknown as { handleMethod: (m: string, p: Record<string, unknown>, a: string) => Promise<Record<string, unknown>> })
        .handleMethod(method, (params ?? {}) as Record<string, unknown>, "127.0.0.1");
    return { srv, call };
  }

  test("tools/list advertises everything when nothing is disabled", async () => {
    const { call } = serverWith([]);
    const listed = ((await call("tools/list")).tools as Array<{ name: string }>).map((t) => t.name);
    expect(listed).toHaveLength(MCP_TOOLS.length);
  });

  test("tools/list hides a disabled tool", async () => {
    const { call } = serverWith(["get_logs"]);
    const listed = ((await call("tools/list")).tools as Array<{ name: string }>).map((t) => t.name);
    expect(listed).not.toContain("get_logs");
    expect(listed).toContain("list_services");
  });

  // Filtering the list is only discovery — an agent holding a stale tool list
  // will still call it, so the call itself has to be refused.
  test("tools/call refuses a disabled tool, and says why", async () => {
    const { call } = serverWith(["get_logs"]);
    const res = await call("tools/call", { name: "get_logs", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("get_logs");
    expect(text).toContain("disabled");
    // Not "unknown tool" — that would send an agent hunting for a typo.
    expect(text).not.toContain("unknown tool");
  });

  test("a tool that is not disabled still dispatches", async () => {
    const { call } = serverWith(["get_logs"]);
    const res = await call("tools/call", { name: "list_profiles", arguments: {} });
    expect(res.isError).toBeUndefined();
  });
});
