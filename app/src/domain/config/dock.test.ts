import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService, type WebDockItem } from "./types.ts";
import { dockConfigIssues, formatDockText, loopbackFetchUrl, resolveDockTarget } from "./dock.ts";

function item(overrides: Partial<WebDockItem> = {}): WebDockItem {
  return {
    id: "queue",
    title: "Invoice queue",
    kind: "text",
    url: "http://127.0.0.1:18000/jobs",
    service: "",
    port: "",
    path: "",
    refresh_seconds: 0,
    ...overrides,
  };
}

function withApi(port = 18000, auto = false) {
  const cfg = defaultConfig();
  const svc = emptyService();
  svc.command = { args: ["python3", "main.py"], shell: false };
  svc.ports = [{ name: "http", value: port, auto }];
  cfg.services.api = svc;
  cfg.web.listen.port = 18900;
  return cfg;
}

describe("dock config", () => {
  test("accepts a loopback text url and an iframe service", () => {
    const cfg = withApi();
    cfg.web.dock = [
      item(),
      item({ id: "billing", title: "Billing", kind: "iframe", url: "", service: "api", path: "/" }),
    ];
    expect(dockConfigIssues(cfg)).toEqual([]);
  });

  test("rejects a public url, the console itself, and a template", () => {
    const cfg = withApi();
    cfg.web.dock = [item({ url: "http://example.com/secret" })];
    expect(dockConfigIssues(cfg)[0]).toContain("loopback");
    cfg.web.dock = [item({ url: "http://127.0.0.1:18900/api/status" })];
    expect(dockConfigIssues(cfg)[0]).toContain("web console");
    cfg.web.dock = [item({ url: "http://127.0.0.1:${services.api.ports.http}/jobs" })];
    expect(dockConfigIssues(cfg)[0]).toContain("literal loopback");
  });

  test("rejects a missing source, a bad kind, a duplicated id, and a short refresh", () => {
    const cfg = withApi();
    cfg.web.dock = [item({ url: "", service: "" })];
    expect(dockConfigIssues(cfg)).toContain("web.dock[0] needs exactly one of url or service");
    cfg.web.dock = [item({ kind: "page" })];
    expect(dockConfigIssues(cfg)[0]).toContain("iframe or text");
    cfg.web.dock = [item(), item({ title: "Again" })];
    expect(dockConfigIssues(cfg).some((issue) => issue.includes("duplicated"))).toBe(true);
    cfg.web.dock = [item({ refresh_seconds: 2 })];
    expect(dockConfigIssues(cfg)[0]).toContain("refresh_seconds");
    cfg.web.dock = [item({ kind: "iframe", refresh_seconds: 10 })];
    expect(dockConfigIssues(cfg)[0]).toContain("applies to kind: text");
  });

  test("rejects a path that climbs out and an unknown service port", () => {
    const cfg = withApi();
    cfg.web.dock = [item({ url: "", service: "api", path: "/../secret" })];
    expect(dockConfigIssues(cfg)[0]).toContain("..");
    cfg.web.dock = [item({ url: "", service: "missing" })];
    expect(dockConfigIssues(cfg)[0]).toContain("not a configured service");
    cfg.web.dock = [item({ url: "", service: "api", port: "grpc" })];
    expect(dockConfigIssues(cfg)[0]).toContain("not declared");
  });

  test("resolves a fixed port, a live port, and waits for an auto port", () => {
    const cfg = withApi();
    const fixed = item({ url: "", service: "api", path: "/jobs" });
    expect(resolveDockTarget(fixed, cfg, {}, 18900)).toEqual({ url: "http://127.0.0.1:18000/jobs", error: "" });
    expect(resolveDockTarget(fixed, cfg, { api: { http: 4100 } }, 18900).url).toBe("http://127.0.0.1:4100/jobs");
    const cfgAuto = withApi(0, true);
    const waiting = resolveDockTarget(item({ url: "", service: "api" }), cfgAuto, {}, 18900);
    expect(waiting.error).toContain("not listening");
  });

  test("formats json and strips html", () => {
    expect(formatDockText("application/json", '{"jobs":[]}')).toBe('{\n  "jobs": []\n}');
    expect(formatDockText("text/html", "<style>p{color:red}</style><h1>Queue</h1><p>3 waiting</p><script>alert(1)</script>")).toBe("Queue\n3 waiting");
    expect(loopbackFetchUrl("http://localhost:18000/jobs")).toBe("http://127.0.0.1:18000/jobs");
  });
});
