import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService, type WebDockItem } from "./types.ts";
import { dockConfigIssues, extractDockMetrics, formatDockText, loopbackFetchUrl, resolveDockTarget } from "./dock.ts";

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
    metrics: [],
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

  test("accepts text metrics and rejects them on an iframe", () => {
    const cfg = withApi();
    cfg.web.dock = [item({
      metrics: [
        { key: "queued", label: "Queued", unit: "" },
        { key: "stats.latency_ms", label: "Latency", unit: "ms" },
        { key: "jobs.0.status", label: "", unit: "" },
      ],
    })];
    expect(dockConfigIssues(cfg)).toEqual([]);
    cfg.web.dock = [item({ kind: "iframe", url: "", service: "api", metrics: [{ key: "queued", label: "", unit: "" }] })];
    expect(dockConfigIssues(cfg)[0]).toContain("applies to kind: text");
    cfg.web.dock = [item({ metrics: [{ key: "queued jobs", label: "", unit: "" }] })];
    expect(dockConfigIssues(cfg)[0]).toContain("dotted JSON key");
    cfg.web.dock = [item({ metrics: [{ key: "queued", label: "", unit: "ms " }] })];
    expect(dockConfigIssues(cfg)[0]).toContain("unit");
    cfg.web.dock = [item({
      metrics: [
        { key: "queued", label: "", unit: "" },
        { key: "queued", label: "Again", unit: "" },
      ],
    })];
    expect(dockConfigIssues(cfg)[0]).toContain("duplicated");
  });

  test("reads configured json keys as metrics", () => {
    const metrics = [
      { key: "queued", label: "Queued", unit: "" },
      { key: "stats.latency_ms", label: "", unit: "ms" },
      { key: "jobs", label: "Jobs", unit: "" },
      { key: "jobs.0.status", label: "First", unit: "" },
      { key: "healthy", label: "", unit: "" },
      { key: "missing", label: "", unit: "" },
    ];
    const body = JSON.stringify({
      queued: 1200,
      stats: { latency_ms: 12.456 },
      jobs: [{ status: "queued" }, { status: "done" }],
      healthy: true,
      note: "",
    });
    const extracted = extractDockMetrics("application/json", body, metrics);
    expect(extracted.error).toBe("");
    expect(extracted.readings).toEqual([
      { key: "queued", label: "Queued", value: "1,200", unit: "", missing: false },
      { key: "stats.latency_ms", label: "Latency ms", value: "12.46", unit: "ms", missing: false },
      { key: "jobs", label: "Jobs", value: "2", unit: "", missing: false },
      { key: "jobs.0.status", label: "First", value: "queued", unit: "", missing: false },
      { key: "healthy", label: "Healthy", value: "Yes", unit: "", missing: false },
      { key: "missing", label: "Missing", value: "—", unit: "", missing: true },
    ]);
    expect(extractDockMetrics("text/plain", "not json", metrics).error).toBe("response is not JSON");
    expect(extractDockMetrics("application/json", body, []).readings).toEqual([]);
    const odd = extractDockMetrics("application/json", JSON.stringify({
      blob: { nested: true },
      blank: "  ",
      note: "x".repeat(60),
      jobs: [{ status: "queued" }],
    }), [
      { key: "blob", label: "", unit: "" },
      { key: "blank", label: "", unit: "" },
      { key: "note", label: "Note", unit: "" },
      { key: "jobs.3.status", label: "Gone", unit: "ms" },
    ]);
    expect(odd.readings.map((reading) => [reading.key, reading.missing, reading.unit])).toEqual([
      ["blob", true, ""],
      ["blank", true, ""],
      ["note", false, ""],
      ["jobs.3.status", true, ""],
    ]);
    expect(odd.readings[2]?.value.endsWith("…")).toBe(true);
  });

  test("rejects more metric keys than the card can show", () => {
    const cfg = withApi();
    cfg.web.dock = [item({
      metrics: ["a", "b", "c", "d", "e", "f", "g"].map((key) => ({ key, label: "", unit: "" })),
    })];
    expect(dockConfigIssues(cfg)[0]).toContain("maximum is 6");
    cfg.web.dock = [item({ metrics: [{ key: "queued", label: "x".repeat(41), unit: "" }] })];
    expect(dockConfigIssues(cfg)[0]).toContain("label");
  });

  test("formats json and strips html", () => {
    expect(formatDockText("application/json", '{"jobs":[]}')).toBe('{\n  "jobs": []\n}');
    expect(formatDockText("text/html", "<style>p{color:red}</style><h1>Queue</h1><p>3 waiting</p><script>alert(1)</script>")).toBe("Queue\n3 waiting");
    expect(loopbackFetchUrl("http://localhost:18000/jobs")).toBe("http://127.0.0.1:18000/jobs");
  });
});
