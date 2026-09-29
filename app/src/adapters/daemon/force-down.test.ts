import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { lockHolderSignalable, type LockRecord } from "../storage/lock.ts";
import { lockPath } from "../storage/storage.ts";
import { processState } from "../process/liveness.ts";
import { forceStopDaemon } from "./force-down.ts";

let root = "";
let repo = "";
let previousHome: string | undefined;
const children: Subprocess[] = [];
const orphans: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devctl-force-down-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (previousHome === undefined) {
    delete process.env.DEVCTL_HOME;
  } else {
    process.env.DEVCTL_HOME = previousHome;
  }
  rmSync(root, { recursive: true, force: true });
});

// A long-lived process whose command line carries `extra`, the way a real
// daemon's carries `_supervisor`.
function sleeper(...extra: string[]): Subprocess {
  const child = spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)", ...extra], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  children.push(child);
  return child;
}

// Like a detached daemon, it is not our child: init reaps it once it is
// killed, instead of it lingering as our zombie.
function orphan(...extra: string[]): number {
  const started = spawnSync("/bin/sh", ["-c", `"$0" -e "setInterval(() => {}, 1000)" "$@" >/dev/null 2>&1 & echo $!`, process.execPath, ...extra], { encoding: "utf8" });
  const pid = Number(started.stdout.trim());
  orphans.push(pid);
  return pid;
}

function writeLock(record: LockRecord): void {
  mkdirSync(join(lockPath(repo), ".."), { recursive: true });
  writeFileSync(lockPath(repo), JSON.stringify(record));
}

describe("down --force", () => {
  test.skipIf(process.platform === "win32")("does not kill a reused v1 pid, and drops the stale lock", async () => {
    const other = sleeper();
    writeLock({ pid: other.pid, socket: join(root, "sock") });
    expect(forceStopDaemon(repo)).toBe(false);
    await Bun.sleep(100);
    expect(processState(other.pid)).toBe("alive");
    expect(existsSync(lockPath(repo))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("stops a v1 lock holder that runs the daemon subcommand", () => {
    const daemon = orphan("_supervisor", "--repo", repo);
    writeLock({ pid: daemon, socket: join(root, "sock") });
    expect(forceStopDaemon(repo)).toBe(true);
    expect(processState(daemon)).not.toBe("alive");
  });

  test.skipIf(process.platform === "win32")("leaves a v2 lock alone when its stamp names an older process", async () => {
    const other = sleeper("_supervisor");
    writeLock({ v: 2, pid: other.pid, socket: join(root, "sock"), nonce: "n", startTicks: "1", lstart: "Thu Jan  1 00:00:00 1970" });
    expect(forceStopDaemon(repo)).toBe(false);
    await Bun.sleep(100);
    expect(processState(other.pid)).toBe("alive");
    expect(existsSync(lockPath(repo))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("never signals a pid from another PID namespace", () => {
    const other = sleeper("_supervisor");
    const record: LockRecord = { pid: other.pid, socket: join(root, "sock"), pidNs: "pid:[4026531836]" };
    expect(lockHolderSignalable(record, { pidNs: "pid:[4026532695]" })).toBe(false);
    expect(lockHolderSignalable(record, {})).toBe(true);
  });
});
