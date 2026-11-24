import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { emptyRuntime } from "../../domain/service/services.ts";
import type { StatusSnapshot } from "../../domain/status.ts";
import { readDock } from "./dock.ts";

function status(): StatusSnapshot {
  return {
    session_id: "s",
    repo_root: "/r",
    profile: "local",
    services: { api: { ...emptyRuntime("api"), ports: { http: 0 } } },
    proxy: { running: false, requestTotal: 0, requestErrors: 0, recentRequests: [] },
    identity: { user: "", project: "", project_source: "", adc: false, service_accounts: {}, service_account_status: {}, iap: false },
    logs: { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
    web: { running: true, port: 18900 },
  };
}

describe("dock reader", () => {
  test("fetches loopback text, pretty-prints json, and does not follow redirects", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/jobs") {
          return Response.json({ jobs: [{ title: "index invoices" }] });
        }
        if (path === "/away") {
          return new Response(null, { status: 302, headers: { location: "http://example.com/secret" } });
        }
        if (path === "/pic") {
          return new Response("not-text", { headers: { "content-type": "image/png" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const port = server.port ?? 0;
    expect(port).toBeGreaterThan(0);
    const cfg = defaultConfig();
    const svc = emptyService();
    svc.ports = [{ name: "http", value: port, auto: false }];
    cfg.services.api = svc;
    cfg.web.listen.port = 18900;
    cfg.web.dock = [
      { id: "queue", title: "Invoice queue", kind: "text", url: "", service: "api", port: "", path: "/jobs", refresh_seconds: 10 },
      { id: "billing", title: "Billing", kind: "iframe", url: `http://localhost:${port}/`, service: "", port: "", path: "", refresh_seconds: 0 },
      { id: "away", title: "Away", kind: "text", url: `http://127.0.0.1:${port}/away`, service: "", port: "", path: "", refresh_seconds: 0 },
      { id: "pic", title: "Pic", kind: "text", url: `http://127.0.0.1:${port}/pic`, service: "", port: "", path: "", refresh_seconds: 0 },
      { id: "remote", title: "Remote", kind: "text", url: "http://example.com/secret", service: "", port: "", path: "", refresh_seconds: 0 },
    ];
    const snap = status();
    snap.services.api = { ...emptyRuntime("api"), ports: { http: port } };
    try {
      const payload = await readDock(cfg, snap, 18900);
      expect(payload.refresh_seconds).toBe(10);
      const queue = payload.items.find((item) => item.id === "queue");
      expect(queue?.text).toContain("index invoices");
      expect(queue?.error).toBeUndefined();
      const billing = payload.items.find((item) => item.id === "billing");
      expect(billing?.url).toBe(`http://localhost:${port}/`);
      expect(billing?.kind).toBe("iframe");
      expect(payload.items.find((item) => item.id === "away")?.error).toBe("redirects are not followed");
      expect(payload.items.find((item) => item.id === "pic")?.error).toBe("the response is not text");
      expect(payload.items.find((item) => item.id === "remote")?.error).toContain("loopback");
      expect(payload.items.find((item) => item.id === "remote")?.text).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
