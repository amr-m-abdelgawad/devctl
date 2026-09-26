import { request as httpRequest } from "node:http";
import { validateConfigText } from "../../adapters/config/index.ts";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyProfile } from "../../domain/config/types.ts";
import { KindGeneral } from "../../shared/errors.ts";
import { emptyRuntime } from "../../domain/service/services.ts";
import { type StatusSnapshot, type TraceResponse } from "../../domain/status.ts";
import type { McpHost } from "../../ports/mcp-host.ts";
import { logRecord } from "../../domain/logs/logs.ts";
import { WebHttpServer } from "./server.ts";

type ControlCall = { tool: string; args: unknown };

const TEST_WEB_TOKEN = "test-web-control-token-aaaaaaaaaaaa";

function host(): McpHost & { calls: ControlCall[] } {
  const cfg = defaultConfig();
  cfg.project.name = "demo";
  cfg.profiles = { local: emptyProfile({ services: ["api"] }) };
  const snap: StatusSnapshot = {
    session_id: "s",
    repo_root: "/r",
    profile: "local",
    services: { api: emptyRuntime("api") },
    proxy: {
      running: true,
      requestTotal: 3,
      requestErrors: 1,
      recentRequests: [{
        timestamp: "2026-01-01T00:00:00.000Z",
        requestId: "req-1",
        method: "GET",
        path: "/invoices",
        route: "invoices-api",
        identity: "user",
        status: 200,
        durationMs: 12,
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
    },
    identity: { user: "", project: "", project_source: "", adc: false, service_accounts: {}, service_account_status: {}, iap: false },
    logs: { total: 1, errors: 0, counts: { api: 1 }, seen: 1, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
    stats_series: { interval_ms: 5000, cpu: [0.1], mem: [0.2] },
    web: { running: true, address: "http://127.0.0.1:18900/", port: 18900 },
  };
  const tree: TraceResponse = {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    requestId: "req-1",
    tree: { traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", spans: [], roots: [] },
    events: [],
  };
  const calls: ControlCall[] = [];
  return {
    calls,
    status: () => snap,
    logsPage: () => ({ events: [], nextCursor: "", prevCursor: "", hasNext: false, hasPrev: false, sessionChanged: false }),
    logsStats: () => ({ total: 3, byService: { api: 3 }, byLevel: { INFO: 2, ERROR: 1 }, bySource: { stdout: 3 } }),
    listLogSessions: () => ["session-abc"],
    loadLogSession: () => [
      logRecord({ timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "hello", pid: 1, seq: 1 }),
    ],
    config: () => cfg,
    validateConfigText: (text) => validateConfigText(cfg.repoRoot, cfg.configPath, text),
    start: async (req) => {
      calls.push({ tool: "start_services", args: req });
      return { profile: req.profile ?? "", waves: [req.services ?? []], steps: [] };
    },
    stop: async (names) => {
      calls.push({ tool: "stop_services", args: names });
    },
    restart: async (names, cascade) => {
      calls.push({ tool: "restart_services", args: { names, cascade } });
    },
    reload: async () => {
      calls.push({ tool: "reload_config", args: {} });
      return { restart_required: [], changes: {} };
    },
    doctor: async () => ({ checks: [], issues: 0 }),
    runTask: async (name) => {
      calls.push({ tool: "run_task", args: name });
      return { task: name, code: 0, stdout: "", stderr: "" };
    },
    startProxy: async () => {
      calls.push({ tool: "start_proxy", args: {} });
    },
    stopProxy: async () => {
      calls.push({ tool: "stop_proxy", args: {} });
    },
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
      layers: {},
      local: { web_enabled: true, web_port: 18900, inspect_max_bytes: 0 },
    }),
    setPreferences: async (patch) => {
      calls.push({ tool: "set_preferences", args: patch });
      return {
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
        scope: patch.scope === "user" ? "user" : "repo",
        locked: false,
        paths: { user: "/u", repo: "/r", write: "/r", local: "/l" },
        layers: {},
        local: { web_enabled: patch.local?.web_enabled === true, web_port: patch.local?.web_port ?? 18900, inspect_max_bytes: patch.local?.inspect_max_bytes ?? 0 },
      };
    },
    getTrace: async (id) => ({ ...tree, traceId: id }),
    traceRequest: async (id) => ({ ...tree, requestId: id }),
    llmCallsPage: () => ({
      calls: [{
        seq: 1,
        id: "chatcmpl-1",
        source: "platform",
        sourceType: "litellm",
        timestamp: "2026-01-01T00:00:00.000Z",
        status: "ok",
        model: "gpt-4o",
        operation: "chat",
        usage: { totalTokens: 16 },
        cost: 0.01,
        attributes: {},
      }],
      nextCursor: "",
      hasNext: false,
      errors: [],
    }),
    getLlmCall: async (id) => ({
      seq: 1,
      id,
      source: "platform",
      sourceType: "litellm",
      timestamp: "2026-01-01T00:00:00.000Z",
      status: "ok",
      model: "gpt-4o",
      operation: "chat",
      request: { messages: [] },
      attributes: {},
    }),
    trafficCallsPage: () => ({
      calls: [{
        seq: 1,
        id: "req-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        method: "GET",
        path: "/invoices",
        route: "invoices-api",
        transport: "http",
        status: 200,
        attributes: {},
      }],
      nextCursor: "",
      hasNext: false,
    }),
    getTrafficCall: async (id) => ({
      seq: 1,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      method: "GET",
      path: "/invoices",
      route: "invoices-api",
      transport: "http",
      status: 200,
      request: { text: '{"ok":true}', encoding: "utf8" },
      attributes: {},
    }),
  };
}

async function listen(api: McpHost = host()): Promise<WebHttpServer> {
  const server = new WebHttpServer({ host: "127.0.0.1", port: 0, token: TEST_WEB_TOKEN, hostApi: api });
  await server.start();
  return server;
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
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return rawRequest(port, { path, headers }).then((res) => res.status);
}

function authGet(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TEST_WEB_TOKEN}` } });
}

function controlHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    Origin: `http://127.0.0.1:${port}`,
    Authorization: `Bearer ${TEST_WEB_TOKEN}`,
    ...extra,
  };
}

async function postControl(port: number, payload: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/control`, {
    method: "POST",
    headers: controlHeaders(port, extra),
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

describe("web http server", () => {
  test("refuses non-loopback bind", async () => {
    const server = new WebHttpServer({ host: "0.0.0.0", port: 18999, token: TEST_WEB_TOKEN, hostApi: host() });
    await expect(server.start()).rejects.toMatchObject({ kind: KindGeneral });
  });

  test("refuses to start without a control token", async () => {
    const server = new WebHttpServer({ host: "127.0.0.1", port: 0, token: "  ", hostApi: host() });
    await expect(server.start()).rejects.toMatchObject({ kind: KindGeneral });
  });

  test("GET / returns HTML and each /api route returns a shaped payload", async () => {
    const server = await listen();
    const port = server.listenPort();
    const base = `http://127.0.0.1:${port}`;
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type") ?? "").toContain("text/html");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(page.headers.get("access-control-allow-origin")).toBeNull();
      expect((await page.text()).toLowerCase()).toContain("<!doctype html>");

      const status = await authGet(base, "/api/status");
      expect(status.status).toBe(200);
      const statusBody = await status.json() as { profile: string; stats_series?: { cpu: number[] }; web: { running: boolean } };
      expect(statusBody.profile).toBe("local");
      expect(statusBody.stats_series?.cpu).toEqual([0.1]);
      expect(statusBody.web.running).toBe(true);

      const services = await authGet(base, "/api/services");
      expect((await services.json() as Array<{ name: string }>)[0]?.name).toBe("api");

      const requests = await authGet(base, "/api/requests");
      expect((await requests.json() as { total: number }).total).toBe(3);

      const config = await authGet(base, "/api/config");
      const configBody = await config.json() as { project: string; tasks: unknown[] };
      expect(configBody.project).toBe("demo");
      expect(configBody.tasks).toEqual([]);

      const profiles = await authGet(base, "/api/profiles");
      expect((await profiles.json() as Array<{ name: string }>)[0]?.name).toBe("local");

      const logs = await authGet(base, "/api/logs?level=ERROR");
      expect(logs.status).toBe(200);

      const stats = await authGet(base, "/api/logs/stats");
      expect((await stats.json() as { total: number; byService: Record<string, number> }).total).toBe(3);

      const sessions = await authGet(base, "/api/logs/sessions");
      expect((await sessions.json() as { sessions: string[] }).sessions).toEqual(["session-abc"]);

      const session = await authGet(base, "/api/logs/sessions/session-abc");
      expect((await session.json() as { events: Array<{ service: string }>; prev_cursor: string }).events[0]?.service).toBe("api");

      const doctor = await authGet(base, "/api/doctor");
      expect((await doctor.json() as { issues: number }).issues).toBe(0);

      const exported = await authGet(base, "/api/logs/export");
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type") ?? "").toContain("ndjson");
      expect(exported.headers.get("content-disposition") ?? "").toContain("devctl-logs.jsonl");

      const trace = await authGet(base, "/api/trace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect((await trace.json() as { trace_id: string }).trace_id).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      const request = await authGet(base, "/api/request/req-1");
      expect((await request.json() as { request_id: string }).request_id).toBe("req-1");

      const llm = await authGet(base, "/api/llm");
      expect((await llm.json() as { calls: Array<{ id: string }> }).calls[0]?.id).toBe("chatcmpl-1");

      const llmDetail = await authGet(base, "/api/llm/chatcmpl-1");
      expect((await llmDetail.json() as { id: string }).id).toBe("chatcmpl-1");

      const traffic = await authGet(base, "/api/traffic");
      const trafficBody = await traffic.json() as { calls: Array<{ id: string; request?: unknown }> };
      expect(trafficBody.calls[0]?.id).toBe("req-1");
      expect(trafficBody.calls[0]?.request).toBeUndefined();

      const trafficDetail = await authGet(base, "/api/traffic/req-1");
      expect((await trafficDetail.json() as { id: string; request?: { text?: string } }).request?.text).toContain("ok");

      const prefs = await authGet(base, "/api/preferences");
      expect((await prefs.json() as { scope: string; local: { web_port: number } }).local.web_port).toBe(18900);

      const update = await authGet(base, "/api/update");
      const updateBody = await update.json() as { current: string; newer: boolean; latest: string };
      expect(update.status).toBe(200);
      expect(updateBody.newer).toBe(false);
      expect(updateBody.latest).toBe("");
      expect(updateBody.current).toBeTruthy();
    } finally {
      await server.stop();
    }
  });

  test("GET /api data routes require the bearer token", async () => {
    const server = await listen();
    const port = server.listenPort();
    const base = `http://127.0.0.1:${port}`;
    try {
      for (const path of ["/api/status", "/api/logs", "/api/logs/stats", "/api/logs/export", "/api/logs/sessions", "/api/doctor", "/api/llm", "/api/config", "/api/preferences", "/api/llm/chatcmpl-1", "/api/traffic", "/api/traffic/req-1"]) {
        const missing = await fetch(`${base}${path}`);
        expect(missing.status).toBe(401);
        const wrong = await fetch(`${base}${path}`, { headers: { Authorization: "Bearer nope" } });
        expect(wrong.status).toBe(401);
        const ok = await authGet(base, path);
        expect(ok.status).toBe(200);
      }
      // The HTML shell stays anonymous so the SPA can bootstrap and read the token.
      expect((await fetch(`${base}/`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("GET /api/update reports a newer GitHub Release from the checker", async () => {
    const server = new WebHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: TEST_WEB_TOKEN,
      hostApi: host(),
      checkUpdate: async () => ({
        current: "0.9.0",
        latest: "0.10.0",
        newer: true,
        hint: "npm i",
        kind: "npm",
        command: ["npm", "install", "--global", "pkg"],
      }),
    });
    await server.start();
    try {
      const res = await authGet(`http://127.0.0.1:${server.listenPort()}`, "/api/update");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ current: "0.9.0", latest: "0.10.0", newer: true, kind: "npm" });
    } finally {
      await server.stop();
    }
  });

  test("POST to inspect routes is 405, spoofed Host is 403, unknown is 404", async () => {
    const server = await listen();
    const port = server.listenPort();
    const base = `http://127.0.0.1:${port}`;
    try {
      const posted = await fetch(`${base}/api/status`, { method: "POST" });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");

      const put = await fetch(`${base}/api/status`, { method: "PUT" });
      expect(put.status).toBe(405);
      expect(put.headers.get("allow")).toBe("GET, POST");

      const spoofed = await rawGet(port, "/api/status", { Host: "evil.example:80" });
      expect(spoofed).toBe(403);

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("POST /api/control runs the same mutating MCP tools", async () => {
    const api = host();
    const server = await listen(api);
    try {
      const started = await postControl(server.listenPort(), { tool: "start_services", args: { profile: "local" } });
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ profile: "local", waves: [[]], steps: [] });

      const stopped = await postControl(server.listenPort(), { tool: "stop_services", args: { services: ["api"] } });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ ok: true });

      const proxy = await postControl(server.listenPort(), { tool: "stop_proxy" });
      expect(proxy.status).toBe(200);

      expect(api.calls.map((call) => call.tool)).toEqual(["start_services", "stop_services", "stop_proxy"]);
      expect(api.calls[0]?.args).toEqual({ services: [], profile: "local" });
      expect(api.calls[1]?.args).toEqual(["api"]);
    } finally {
      await server.stop();
    }
  });

  test("POST /api/control rejects inspect tools, exec, and invalid JSON", async () => {
    const api = host();
    const server = await listen(api);
    const base = `http://127.0.0.1:${server.listenPort()}`;
    try {
      const inspect = await postControl(server.listenPort(), { tool: "list_services" });
      expect(inspect.status).toBe(400);
      expect((await inspect.json() as { error: string }).error).toContain("non-mutating");

      const exec = await postControl(server.listenPort(), { tool: "exec_service", args: { service: "api", command: ["true"] } });
      expect(exec.status).toBe(400);

      const invalid = await postControl(server.listenPort(), "not-json");
      expect(invalid.status).toBe(400);

      const getControl = await fetch(`${base}/api/control`);
      expect(getControl.status).toBe(405);
      expect(getControl.headers.get("allow")).toBe("POST");

      expect(api.calls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("POST /api/control rejects cross-origin and non-JSON requests", async () => {
    const api = host();
    const server = await listen(api);
    const port = server.listenPort();
    const body = JSON.stringify({ tool: "stop_services", args: { services: ["api"] } });
    try {
      const missing = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${TEST_WEB_TOKEN}`,
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(missing.status).toBe(403);

      const remote = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${TEST_WEB_TOKEN}`,
          Origin: "https://evil.example",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(remote.status).toBe(403);

      const referer = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${TEST_WEB_TOKEN}`,
          Referer: `http://127.0.0.1:${port}/`,
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(referer.status).toBe(200);

      const form = await postControl(port, { tool: "stop_proxy" }, { "content-type": "text/plain" });
      expect(form.status).toBe(415);

      expect(api.calls.map((call) => call.tool)).toEqual(["stop_services"]);
    } finally {
      await server.stop();
    }
  });

  test("POST /api/control requires a bearer token, not Origin alone", async () => {
    const api = host();
    const server = await listen(api);
    const port = server.listenPort();
    const body = JSON.stringify({ tool: "stop_proxy" });
    try {
      const originOnly = await fetch(`http://127.0.0.1:${port}/api/control`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: `http://127.0.0.1:${port}`,
        },
        body,
      });
      expect(originOnly.status).toBe(401);
      expect((await originOnly.json() as { error: string }).error).toBe("unauthorized");

      const wrong = await postControl(port, { tool: "stop_proxy" }, { Authorization: "Bearer wrong-token" });
      expect(wrong.status).toBe(401);

      const ok = await postControl(port, { tool: "stop_proxy" });
      expect(ok.status).toBe(200);
      expect(api.calls.map((call) => call.tool)).toEqual(["stop_proxy"]);
    } finally {
      await server.stop();
    }
  });

  test("POST /api/control returns 413 for an oversized body", async () => {
    const api = host();
    const server = await listen(api);
    const port = server.listenPort();
    const body = `{"tool":"stop_proxy","pad":"${"x".repeat(70 * 1024)}"}`;
    try {
      const oversized = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          ...controlHeaders(port),
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(oversized.status).toBe(413);
      expect(JSON.parse(oversized.body)).toEqual({ error: "payload too large" });
      expect(api.calls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("GET / allows loopback Host variants used by WSL and port forwarding", async () => {
    const server = await listen();
    const port = server.listenPort();
    try {
      const allowed = [
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        "127.0.0.1",
        "localhost",
        `[::1]:${port}`,
        "[::1]",
        "::1",
        `::1:${port}`,
        `[::ffff:127.0.0.1]:${port}`,
        `localhost.:${port}`,
        `127.0.0.2:${port}`,
        "localhost:8080",
        `[0:0:0:0:0:0:0:1]:${port}`,
      ];
      for (const host of allowed) {
        expect(await rawGet(port, "/", { Host: host })).toBe(200);
      }

      const denied = [
        "evil.example",
        "cursor:18900",
        "host.docker.internal:18900",
        "0.0.0.0:18900",
        " ",
      ];
      for (const host of denied) {
        const res = await rawRequest(port, { path: "/", headers: { Host: host } });
        expect(res.status).toBe(403);
        expect(JSON.parse(res.body)).toEqual({ error: "forbidden" });
      }
    } finally {
      await server.stop();
    }
  });

  test("POST /api/control allows loopback Origin with remapped ports, IPv6, and https", async () => {
    const api = host();
    const server = await listen(api);
    const port = server.listenPort();
    const body = JSON.stringify({ tool: "stop_proxy" });
    try {
      const allowedOrigins = [
        `http://127.0.0.1:${port}`,
        "http://localhost:8080",
        `http://[::1]:${port}`,
        `https://127.0.0.1:${port}`,
        "https://localhost",
        "http://127.0.0.1",
      ];
      for (const origin of allowedOrigins) {
        const res = await rawRequest(port, {
          method: "POST",
          path: "/api/control",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${TEST_WEB_TOKEN}`,
            Origin: origin,
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        });
        expect(res.status).toBe(200);
      }

      const remote = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${TEST_WEB_TOKEN}`,
          Origin: "https://evil.example",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(remote.status).toBe(403);
      expect(JSON.parse(remote.body)).toEqual({ error: "cross-origin request rejected" });

      const referer = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${TEST_WEB_TOKEN}`,
          Referer: "http://localhost:8080/",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(referer.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("GET /api/logs parses query-string paging fields", async () => {
    const api = host();
    let seen: Parameters<McpHost["logsPage"]>[0] | undefined;
    api.logsPage = (req) => {
      seen = req;
      return { events: [], nextCursor: "n", prevCursor: "p", hasNext: false, hasPrev: false, sessionChanged: false };
    };
    const server = await listen(api);
    try {
      const res = await authGet(`http://127.0.0.1:${server.listenPort()}`, "/api/logs?limit=25&direction=backward&regex=true&search=err&cursor=8");
      expect(res.status).toBe(200);
      expect((await res.json() as { prev_cursor: string }).prev_cursor).toBe("p");
      expect(seen?.limit).toBe(25);
      expect(seen?.direction).toBe("backward");
      expect(seen?.regex).toBe(true);
      expect(seen?.search).toBe("err");
      expect(seen?.cursor).toBe("8");
      const defaults = await authGet(`http://127.0.0.1:${server.listenPort()}`, "/api/logs");
      expect(defaults.status).toBe(200);
      expect(seen?.limit).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("GET /api/logs/stats forwards the active filter", async () => {
    const api = host();
    let seen: Parameters<McpHost["logsStats"]>[0] | undefined;
    api.logsStats = (req) => {
      seen = req;
      return { total: 1, byService: { api: 1 }, byLevel: { ERROR: 1 }, bySource: { stderr: 1 } };
    };
    const server = await listen(api);
    try {
      const res = await authGet(`http://127.0.0.1:${server.listenPort()}`, "/api/logs/stats?level=ERROR&regex=true");
      expect(await res.json()).toEqual({ total: 1, byService: { api: 1 }, byLevel: { ERROR: 1 }, bySource: { stderr: 1 } });
      expect(seen?.level).toBe("ERROR");
      expect(seen?.regex).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("GET /api/logs/sessions/:id pages redacted events and 404s unknown ids", async () => {
    const api = host();
    api.loadLogSession = () => [
      logRecord({ timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "Authorization: Bearer super-secret-token-value", pid: 1, seq: 1 }),
      logRecord({ timestamp: "t2", service: "api", source: "stdout", level: "INFO", message: "ok", pid: 1, seq: 2 }),
      logRecord({ timestamp: "t3", service: "api", source: "stdout", level: "INFO", message: "later", pid: 1, seq: 3 }),
    ];
    const server = await listen(api);
    const base = `http://127.0.0.1:${server.listenPort()}`;
    try {
      const page = await authGet(base, "/api/logs/sessions/session-abc?limit=2");
      const body = await page.json() as { events: Array<{ seq: number; message: string }>; prev_cursor: string; truncated: boolean };
      expect(body.events.map((ev) => ev.seq)).toEqual([2, 3]);
      expect(body.events[0]?.message).not.toContain("super-secret");
      expect(body.prev_cursor).toBe("2");
      expect(body.truncated).toBe(true);
      expect((await authGet(base, "/api/logs/sessions/nope")).status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("GET /api/logs/export streams redacted JSONL oldest-first", async () => {
    const api = host();
    const ev1 = logRecord({ timestamp: "t1", service: "api", source: "stdout", level: "INFO", message: "first", pid: 1, seq: 1 });
    const ev2 = logRecord({ timestamp: "t2", service: "api", source: "stdout", level: "INFO", message: "Authorization: Bearer super-secret-token-value", pid: 1, seq: 2 });
    api.logsPage = (req) => {
      if (!req.cursor) {
        return { events: [ev2], nextCursor: "2", prevCursor: "2", hasNext: false, hasPrev: true, sessionChanged: false };
      }
      if (req.direction === "backward") {
        return { events: [ev1], nextCursor: "1", prevCursor: "1", hasNext: true, hasPrev: false, sessionChanged: false };
      }
      return { events: [ev2], nextCursor: "2", prevCursor: "2", hasNext: false, hasPrev: true, sessionChanged: false };
    };
    const server = await listen(api);
    try {
      const res = await authGet(`http://127.0.0.1:${server.listenPort()}`, "/api/logs/export?service=api");
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] as string).seq).toBe(1);
      expect(text).not.toContain("super-secret");
    } finally {
      await server.stop();
    }
  });
});
