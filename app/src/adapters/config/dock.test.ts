import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { applyWeb } from "./merge.ts";
import { collectUnknownFields } from "./strict.ts";
import { validate } from "./validate.ts";

describe("web dock config", () => {
  test("applyWeb keeps a text card and a service iframe", () => {
    const cfg = defaultConfig();
    applyWeb(cfg.web, {
      dock: [
        { id: "queue", title: "Invoice queue", kind: "text", service: "api", path: "/jobs", refresh_seconds: 10, metrics: [{ key: "queued", label: "Queued" }] },
        { id: "billing", title: "Billing", kind: "iframe", url: "http://127.0.0.1:18003/" },
      ],
    });
    expect(cfg.web.dock).toEqual([
      { id: "queue", title: "Invoice queue", kind: "text", url: "", service: "api", port: "", path: "/jobs", refresh_seconds: 10, metrics: [{ key: "queued", label: "Queued", unit: "" }] },
      { id: "billing", title: "Billing", kind: "iframe", url: "http://127.0.0.1:18003/", service: "", port: "", path: "", refresh_seconds: 0, metrics: [] },
    ]);
  });

  test("unknown dock fields are rejected and a loopback card validates", () => {
    expect(collectUnknownFields({
      dock: [{ id: "queue", title: "Queue", kind: "text", url: "http://127.0.0.1:1/", extra: true }],
    }, "web")).toContain("web.dock.0.extra");
    expect(collectUnknownFields({
      dock: [{ id: "queue", title: "Queue", kind: "text", url: "http://127.0.0.1:1/", metrics: [{ key: "queued", extra: true }] }],
    }, "web")).toContain("web.dock.0.metrics.0.extra");
    const cfg = defaultConfig();
    const svc = emptyService();
    svc.command = { args: ["echo", "ok"], shell: false };
    svc.ports = [{ name: "http", value: 18000, auto: false }];
    cfg.services.api = svc;
    applyWeb(cfg.web, {
      dock: [{ id: "queue", title: "Invoice queue", kind: "text", service: "api", path: "/jobs" }],
    });
    expect(validate(cfg).filter((issue) => issue.startsWith("web.dock"))).toEqual([]);
    applyWeb(cfg.web, {
      dock: [{ id: "queue", title: "Invoice queue", kind: "text", service: "api", path: "/jobs", metrics: "queued" }],
    });
    expect(validate(cfg).some((issue) => issue.includes("dotted JSON key"))).toBe(true);
  });
});
