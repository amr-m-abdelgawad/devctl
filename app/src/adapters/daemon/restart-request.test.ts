import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startEventLoopWatchdog } from "./event-loop-watchdog.ts";
import { restartRequestPath, writeRestartRequest } from "./heartbeat.ts";

let root = "";
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devctl-restart-"));
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

describe("restart requests", () => {
  test("a stale request left by a previous daemon does not stop a fresh one", async () => {
    const repo = join(root, "repo");
    writeRestartRequest(repo);
    let restarts = 0;
    const watchdog = startEventLoopWatchdog({ repoRoot: repo, session: "fresh", identity: String(process.pid) });
    watchdog.noteRestartRequest(() => {
      restarts += 1;
    });
    await Bun.sleep(1_300);
    watchdog.stop();
    expect(restarts).toBe(0);
  });

  test("a request addressed to this daemon restarts it exactly once and is consumed", async () => {
    const repo = join(root, "repo");
    let restarts = 0;
    const watchdog = startEventLoopWatchdog({ repoRoot: repo, session: "live", identity: String(process.pid) });
    watchdog.noteRestartRequest(() => {
      restarts += 1;
    });
    writeRestartRequest(repo, { pid: process.pid, session: "live" });
    await Bun.sleep(2_300);
    watchdog.stop();
    expect(restarts).toBe(1);
    expect(existsSync(restartRequestPath(repo))).toBe(false);
  });
});
