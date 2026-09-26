import { describe, expect, test } from "bun:test";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { defaultConfig, emptyHealth, emptyService } from "../../domain/config/types.ts";
import { emptyRuntime, type Plan } from "../../domain/service/services.ts";
import type { StatusSnapshot } from "../../domain/status.ts";
import { exitCode } from "../../shared/errors.ts";
import { writeBundle } from "./harness.ts";
import { waitForStack } from "./wait.ts";

const SECRET = "sk-live-unit0123456789abcdef";

function config() {
  const cfg = defaultConfig();
  cfg.repoRoot = "/repo";
  cfg.services.api = { ...emptyService(), health: { ...emptyHealth(), type: "http", url: "http://127.0.0.1:1/" }, environment: { vars: { API_TOKEN: SECRET }, required: [], defaults: {} } };
  return cfg;
}

function snap(state: string, health = "UNKNOWN"): StatusSnapshot {
  return { services: { api: { ...emptyRuntime("api"), state, health, ports: { http: 18100 } } }, mcp: { running: true, token: "mcp-bearer-token-value" } } as unknown as StatusSnapshot;
}

const PLAN: Plan = { profile: "", steps: [], waves: [["api"]] };

describe("waitForStack", () => {
  test("returns once the service is healthy", async () => {
    const states = [snap("STARTING"), snap("RUNNING"), snap("HEALTHY", "HEALTHY")];
    const ctrl = { status: async () => states.shift() ?? snap("HEALTHY", "HEALTHY") };
    await waitForStack(ctrl, config(), PLAN, 5_000);
    expect(states).toEqual([]);
  });

  test("a failed service exits 5, a timeout exits 6, a blocker exits 5", async () => {
    const failed = { status: async () => ({ services: { api: { ...emptyRuntime("api"), state: "FAILED", last_error: "exit 1" } } }) as unknown as StatusSnapshot };
    expect(exitCode(await waitForStack(failed, config(), PLAN, 5_000).catch((err: unknown) => err))).toBe(5);
    const stuck = { status: async () => snap("RUNNING") };
    const timeout = await waitForStack(stuck, config(), PLAN, 1).catch((err: unknown) => err);
    expect(exitCode(timeout)).toBe(6);
    expect(String(timeout)).toContain("api (RUNNING)");
    const blocked = await waitForStack(stuck, config(), { ...PLAN, blockers: [{ name: "api", message: "port 18100 is taken" }] }, 5_000).catch((err: unknown) => err);
    expect(exitCode(blocked)).toBe(5);
  });
});

describe("writeBundle", () => {
  function fakes(opts: { daemon: boolean }) {
    const files = new Map<string, string>();
    const cfg = config();
    const noDaemon = async () => {
      throw new Error("supervisor is not running");
    };
    const ctrl = {
      cfg,
      status: opts.daemon ? async () => snap("HEALTHY", "HEALTHY") : noDaemon,
      logs: opts.daemon ? async () => [{ severityText: "ERROR", traceId: "t1", body: `token=${SECRET}` }] : noDaemon,
      getTrace: async (id: string) => ({ traceId: id, tree: {}, events: [] }),
      trafficCallsPage: opts.daemon ? async () => ({ calls: [], nextCursor: "", hasNext: false }) : noDaemon,
    } as unknown as Controller;
    const runtime = {
      writeSecretFile: (path: string, text: string) => files.set(path.split(/[\\/]/).pop() ?? path, text),
      runDoctor: { execute: async () => ({ issues: 0, checks: [] }) },
      configDiff: () => [{ path: "services.api.environment.API_TOKEN", value: SECRET, source: "config.yaml", layer: "main", shadowed: [] }],
      bootstrapLogPath: () => "/state/bootstrap.log",
      fileExists: () => true,
      readTextFile: () => `starting with ${SECRET}\n`,
    } as unknown as ClientRuntime;
    return { files, ctrl, runtime };
  }

  test("every file is redacted and the MCP token is dropped", async () => {
    const { files, ctrl, runtime } = fakes({ daemon: true });
    const written = await writeBundle(runtime, ctrl, "/out", { now: new Date("2026-09-26T12:00:00Z") });
    expect(written.sort()).toEqual(["bootstrap.log", "config-diff.json", "doctor.json", "logs.ndjson", "status.json", "traces.json", "traffic.json", "versions.txt"]);
    for (const [name, text] of files) {
      expect({ name, leaked: text.includes(SECRET) || text.includes("mcp-bearer-token-value") }).toEqual({ name, leaked: false });
    }
    expect(files.get("logs.ndjson")).toContain("token=********");
    expect(JSON.parse(files.get("traces.json") ?? "[]")).toEqual([{ traceId: "t1", tree: {}, events: [] }]);
  });

  test("without a supervisor it still writes what it can, and says what it could not", async () => {
    const { files, ctrl, runtime } = fakes({ daemon: false });
    await writeBundle(runtime, ctrl, "/out", {});
    expect([...files.keys()].sort()).toEqual(["bootstrap.log", "config-diff.json", "doctor.json", "errors.txt", "versions.txt"]);
    expect(files.get("errors.txt")).toContain("status.json: supervisor is not running");
  });
});
