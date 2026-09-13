import { request as httpRequest } from "node:http";
import { validateConfigText } from "../../adapters/config/index.ts";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { KindGeneral } from "../../shared/errors.ts";
import { emptyRuntime } from "../../domain/service/services.ts";
import { type StatusSnapshot, type TraceResponse } from "../../domain/status.ts";
import type { McpHost } from "../../ports/mcp-host.ts";
import { WebHttpServer } from "./server.ts";

type ControlCall = { tool: string; args: unknown };

function host(): McpHost & { calls: ControlCall[] } {
  const cfg = defaultConfig();
  cfg.project.name = "demo";
  cfg.profiles = { local: { services: ["api"], environment: {} } };
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
    getTrace: async (id) => ({ ...tree, traceId: id }),
    traceRequest: async (id) => ({ ...tree, requestId: id }),
  };
}

async function listen(api: McpHost = host()): Promise<WebHttpServer> {
  const server = new WebHttpServer({ host: "127.0.0.1", port: 0, hostApi: api });
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

function controlHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    Origin: `http://127.0.0.1:${port}`,
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
    const server = new WebHttpServer({ host: "0.0.0.0", port: 18999, hostApi: host() });
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
      expect(page.headers.get("access-control-allow-origin")).toBeNull();
      expect((await page.text()).toLowerCase()).toContain("<!doctype html>");

      const status = await fetch(`${base}/api/status`);
      expect(status.status).toBe(200);
      const statusBody = await status.json() as { profile: string; stats_series?: { cpu: number[] }; web: { running: boolean } };
      expect(statusBody.profile).toBe("local");
      expect(statusBody.stats_series?.cpu).toEqual([0.1]);
      expect(statusBody.web.running).toBe(true);

      const services = await fetch(`${base}/api/services`);
      expect((await services.json() as Array<{ name: string }>)[0]?.name).toBe("api");

      const requests = await fetch(`${base}/api/requests`);
      expect((await requests.json() as { total: number }).total).toBe(3);

      const config = await fetch(`${base}/api/config`);
      const configBody = await config.json() as { project: string; tasks: unknown[] };
      expect(configBody.project).toBe("demo");
      expect(configBody.tasks).toEqual([]);

      const profiles = await fetch(`${base}/api/profiles`);
      expect((await profiles.json() as Array<{ name: string }>)[0]?.name).toBe("local");

      const logs = await fetch(`${base}/api/logs?level=ERROR`);
      expect(logs.status).toBe(200);

      const trace = await fetch(`${base}/api/trace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
      expect((await trace.json() as { trace_id: string }).trace_id).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      const request = await fetch(`${base}/api/request/req-1`);
      expect((await request.json() as { request_id: string }).request_id).toBe("req-1");
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
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        body,
      });
      expect(missing.status).toBe(403);

      const remote = await rawRequest(port, {
        method: "POST",
        path: "/api/control",
        headers: {
          "content-type": "application/json",
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
});
