import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "./daemon.ts";
import { Supervisor } from "../adapters/daemon/supervisor.ts";
import { TokenManager } from "../adapters/google/token.ts";
import { ProcessManager } from "../adapters/process/processes.ts";
import { defaultConfig } from "../domain/config/types.ts";
import { Bus, AuthenticationChanged, LogReceived } from "../shared/events.ts";
import type { Clock } from "../ports/clock.ts";
import type { FileSystem } from "../ports/filesystem.ts";

// These compile-time contracts prevent optional defaults from returning to the host.
type Deps = ConstructorParameters<typeof Supervisor>[1];
type Core = "tokens" | "procs" | "clock" | "fs" | "bus" | "detectGoogle" | "healthCheckers" | "orchestrator" | "logs" | "detector" | "sessionID" | "inspectProcess" | "processAlive" | "acquireLock" | "socketExists" | "unlinkSocket" | "createMcpListener" | "createWebListener" | "isKnownTool" | "createCommands";
type OptionalCore = { [K in Core]: undefined extends Deps[K] ? K : never }[Core];
const coreIsRequired: OptionalCore extends never ? true : false = true;

test("daemon composition shares supplied clock, filesystem, bus, and identity dependencies", async () => {
  expect(coreIsRequired).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "devctl-composition-"));
  const previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = join(root, "home");
  const cfg = defaultConfig();
  cfg.repoRoot = root;
  cfg.configPath = join(root, "config.yaml");
  cfg.logs.persistence.enabled = false;
  const bus = new Bus(32);
  const now = new Date("2025-01-02T03:04:05.000Z");
  const clock: Clock = { now: () => now, isoNow: () => now.toISOString(), unixMs: () => now.getTime() };
  const paths: string[] = [];
  const fs: FileSystem = {
    exists: (path) => { paths.push(path); return true; },
    readText: () => { throw new Error("unexpected filesystem read"); },
    writeText: () => { throw new Error("unexpected filesystem write"); },
  };
  const tokens = new TokenManager(1000, [], bus, {
    backend: "file", get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [],
  }, clock);
  const events: string[] = [];
  const logTimes: unknown[] = [];
  bus.subscribe((event) => {
    events.push(event.type);
    if (event.type === LogReceived) logTimes.push((event.payload?.event as { timestamp: string }).timestamp);
  });
  const projects: string[] = [];
  let runtime: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    runtime = await createDaemon(cfg, {
      clock, fs, bus, tokens, processes: new ProcessManager(),
      detectGoogle: async (project) => {
        projects.push(project);
        return { gcloudInstalled: false, adcAvailable: false, userEmail: "fixture@example.com", projectID: "fixture", projectSource: "test" };
      },
    });
    expect(runtime.clock).toBe(clock);
    expect(runtime.fs).toBe(fs);
    expect(paths).toContain(cfg.configPath);
    expect(runtime.supervisor.snapshot().setup_mode).toBeUndefined();
    await runtime.supervisor.refreshIdentity();
    expect(projects).toEqual([cfg.google.project_id]);
    expect(runtime.supervisor.snapshot().identity.user).toBe("fixture@example.com");
    expect(events).toContain(AuthenticationChanged);
    await waitFor(() => logTimes.length > 0);
    expect(logTimes.every((time) => time === now.toISOString())).toBe(true);
  } finally {
    await runtime?.supervisor.shutdown(false);
    if (previousHome === undefined) delete process.env.DEVCTL_HOME;
    else process.env.DEVCTL_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for log worker events");
}
