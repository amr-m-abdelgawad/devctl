import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyHealth, emptyService } from "./config/types.ts";
import { emptyRuntime, type ServiceHealth, type ServiceState } from "./service/services.ts";
import { Detector } from "../shared/redaction.ts";
import type { StatusSnapshot } from "./status.ts";
import { configSecretValues, failedTraceIds, formatDuration, maskKnownValues, parseDuration, readinessMessage, redactJson, stackEnvironment, stackReadiness } from "./harness.ts";

function config() {
  const cfg = defaultConfig();
  cfg.services.api = { ...emptyService(), health: { ...emptyHealth(), type: "http", url: "http://127.0.0.1:1/health" } };
  cfg.services.worker = emptyService();
  return cfg;
}

function snapshot(services: Record<string, { state: string; health?: string; last_error?: string; ports?: Record<string, number> }>): StatusSnapshot {
  const out: StatusSnapshot["services"] = {};
  for (const [name, rt] of Object.entries(services)) {
    out[name] = { ...emptyRuntime(name), state: rt.state as ServiceState, health: (rt.health ?? "UNKNOWN") as ServiceHealth, last_error: rt.last_error ?? "", ports: rt.ports ?? {} };
  }
  return { services: out } as unknown as StatusSnapshot;
}

describe("stack readiness (#118)", () => {
  test("a checked service is ready once HEALTHY; an unchecked one once running", () => {
    const cfg = config();
    expect(stackReadiness(cfg, ["api", "worker"], snapshot({ api: { state: "HEALTHY", health: "HEALTHY" }, worker: { state: "RUNNING" } })).ready).toBe(true);
    const starting = stackReadiness(cfg, ["api", "worker"], snapshot({ api: { state: "RUNNING", health: "UNKNOWN" }, worker: { state: "STARTING" } }));
    expect(starting.ready).toBe(false);
    expect(starting.waiting).toEqual([
      { name: "api", state: "RUNNING" },
      { name: "worker", state: "STARTING" },
    ]);
  });

  test("a failed service is reported, not waited on", () => {
    const readiness = stackReadiness(config(), ["api"], snapshot({ api: { state: "FAILED", last_error: "exit 1" } }));
    expect(readiness.failed).toEqual([{ name: "api", error: "exit 1" }]);
    expect(readinessMessage(readiness)).toBe("services failed to start: api (exit 1)");
  });

  test("the timeout message names what is still not ready", () => {
    const readiness = stackReadiness(config(), ["api"], snapshot({ api: { state: "UNHEALTHY", health: "UNHEALTHY" } }));
    expect(readinessMessage(readiness, 120_000)).toBe("services not ready after 2m: api (UNHEALTHY)");
  });
});

describe("durations", () => {
  test("accept ms, s, m, h and bare seconds", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("30")).toBe(30_000);
    expect(() => parseDuration("soon")).toThrow('invalid duration "soon"');
    expect(formatDuration(90_000)).toBe("90s");
  });
});

describe("the test command's stack environment", () => {
  test("carries the instance, the proxy URL and every running port", () => {
    const snap = { ...snapshot({ api: { state: "HEALTHY", ports: { http: 18100, "admin-ui": 18101 } }, "db-main": { state: "RUNNING", ports: { db: 5532 } } }), proxy: { running: true, address: "127.0.0.1:18180" } } as StatusSnapshot;
    expect(stackEnvironment(snap, "test-1a2b3c")).toEqual({
      DEVCTL_INSTANCE: "test-1a2b3c",
      DEVCTL_PROXY_URL: "http://127.0.0.1:18180",
      DEVCTL_API_HTTP_PORT: "18100",
      DEVCTL_API_ADMIN_UI_PORT: "18101",
      DEVCTL_DB_MAIN_DB_PORT: "5532",
    });
  });
});

describe("bundle redaction", () => {
  test("masks secret-named keys and known token shapes at any depth, dropping nothing", () => {
    // writeBundle always builds its detector with redaction on, whatever secrets.redact says.
    const detector = new Detector([], [], true);
    const out = redactJson(detector, {
      services: { api: { env: { API_TOKEN: "abc", PLAIN: "keep" } } },
      lines: ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZw", ...Array.from({ length: 150 }, (_, i) => `line ${i}`)],
    }) as { services: { api: { env: Record<string, string> } }; lines: string[] };
    expect(out.services.api.env).toEqual({ API_TOKEN: "********", PLAIN: "keep" });
    expect(out.lines[0]).not.toContain("eyJzdWIiOiIxIn0");
    expect(out.lines).toHaveLength(151);
  });

  test("a secret the config spells out is masked wherever a service printed it", () => {
    const detector = new Detector([], [], true);
    const cfg = {
      services: { api: { environment: { API_TOKEN: "sk-live-abcdef0123456789", LOG_LEVEL: "debug", DB_PASSWORD: "${DB_PASSWORD}" } } },
    };
    const known = configSecretValues(detector, cfg);
    expect(known).toEqual(["sk-live-abcdef0123456789"]);
    const line = JSON.stringify({ body: "token=sk-live-abcdef0123456789 level=debug" });
    expect(maskKnownValues(line, known)).toBe('{"body":"token=******** level=debug"}');
  });

  test("failed traces come from 5xx proxied requests and error logs", () => {
    const snap = { ...snapshot({}), proxy: { running: true, recentRequests: [{ status: 200, traceId: "ok" }, { status: 502, traceId: "t1" }] } } as unknown as StatusSnapshot;
    const logs = [{ severityText: "ERROR", traceId: "t2" }, { severityText: "INFO", traceId: "t3" }, { severityText: "ERROR", traceId: "t1" }];
    expect(failedTraceIds(logs, snap, 10)).toEqual(["t1", "t2"]);
  });
});
