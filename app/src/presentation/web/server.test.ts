import { request as httpRequest } from "node:http";
import { validateConfigText } from "../../adapters/config/index.ts";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { KindGeneral } from "../../shared/errors.ts";
import { emptyRuntime } from "../../domain/service/services.ts";
import { type StatusSnapshot, type TraceResponse } from "../../domain/status.ts";
import type { McpHost } from "../../ports/mcp-host.ts";
import { WebHttpServer } from "./server.ts";

function host(): McpHost {
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
    logs: { total: 1, errors: 0, counts: { api: 1 } },
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
  return {
    status: () => snap,
    logsPage: () => ({ events: [], nextCursor: "", prevCursor: "", hasNext: false, hasPrev: false, sessionChanged: false }),
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
    getTrace: async (id) => ({ ...tree, traceId: id }),
    traceRequest: async (id) => ({ ...tree, requestId: id }),
  };
}

async function listen(): Promise<WebHttpServer> {
  const server = new WebHttpServer({ host: "127.0.0.1", port: 0, hostApi: host() });
  await server.start();
  return server;
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
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
      expect((await config.json() as { project: string }).project).toBe("demo");

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

  test("non-GET is 405, spoofed Host is 403, unknown is 404", async () => {
    const server = await listen();
    const port = server.listenPort();
    const base = `http://127.0.0.1:${port}`;
    try {
      const posted = await fetch(`${base}/api/status`, { method: "POST" });
      expect(posted.status).toBe(405);

      const spoofed = await rawGet(port, "/api/status", { Host: "evil.example:80" });
      expect(spoofed).toBe(403);

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
