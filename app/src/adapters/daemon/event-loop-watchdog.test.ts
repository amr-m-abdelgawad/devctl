import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eventLoopStalled, startEventLoopWatchdog, watchdogFailures, watchdogRespawnTicks, watchdogTickAdvanced, WATCHDOG_TICK_MS } from "./event-loop-watchdog.ts";
import { readHeartbeat } from "./heartbeat.ts";
import { watchdogState } from "./resource-probe.ts";

describe("event loop watchdog", () => {
  test("a stall is many worker ticks without a main-thread beat", () => {
    expect(eventLoopStalled(19)).toBe(false);
    expect(eventLoopStalled(20)).toBe(true);
  });

  test("a burst of callbacks after resume counts as one tick", () => {
    expect(watchdogTickAdvanced(0)).toBe(false);
    expect(watchdogTickAdvanced(100)).toBe(false);
    expect(watchdogTickAdvanced(500)).toBe(true);
    expect(watchdogTickAdvanced(60_000)).toBe(true);
  });

  test("a failing worker is respawned after 1, 2, 4 ... ticks, never more than a minute apart", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(watchdogRespawnTicks)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  test("only a worker that stayed up for the whole cap resets the backoff", () => {
    expect(watchdogFailures(0, 5)).toBe(1);
    expect(watchdogFailures(3, 5)).toBe(4);
    expect(watchdogFailures(3, 59_000)).toBe(4);
    expect(watchdogFailures(6, 60_000)).toBe(1);
  });
});

describe("watchdog worker failure", () => {
  let root = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devctl-watchdog-"));
    mkdirSync(join(root, "repo"), { recursive: true });
    previousHome = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = join(root, "home");
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.DEVCTL_HOME;
    } else {
      process.env.DEVCTL_HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("backs off instead of respawning every tick, and marks the heartbeat degraded at once", async () => {
    const repo = join(root, "repo");
    const starts = join(root, "starts");
    const script = join(root, "crash-worker.ts");
    writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(starts)}, "x");\nthrow new Error("crash");\n`);
    const started = Date.now();
    const watchdog = startEventLoopWatchdog({ repoRoot: repo, session: "s", identity: "1", script: pathToFileURL(script) });
    try {
      while (readHeartbeat(repo)?.degraded !== true && Date.now() - started < 2_000) {
        await Bun.sleep(20);
      }
      expect(readHeartbeat(repo)?.degraded).toBe(true);
      expect(watchdogState()).toBe("degraded");
      // Spawned at 0 and after one tick; the third waits two more ticks. A
      // respawn on every tick would have started it three times by now.
      await Bun.sleep(Math.max(0, started + WATCHDOG_TICK_MS * 2.6 - Date.now()));
      expect(readFileSync(starts, "utf8").length).toBeLessThanOrEqual(2);
    } finally {
      watchdog.stop();
    }
  });
});
