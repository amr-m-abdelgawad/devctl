import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { newRoot } from "./test-client.ts";
import { readHeartbeat, writeRestartRequest } from "../adapters/daemon/heartbeat.ts";
import { processAlive, readPersistedState, readRepoLock } from "../adapters/storage/storage.ts";

async function run(args: string[]): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await newRoot().parseAsync(["node", "devctl", ...args], { from: "node" });
  } finally {
    process.stdout.write = original;
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  return check();
}

// Wedge replacement writes a restart request for the daemon, then sends
// SIGTERM. A daemon whose loop comes back in time must hand its services
// over, as a graceful restart does, rather than stop them on the way out.
test.skipIf(process.platform === "win32")("SIGTERM after a restart request hands the services over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devctl-handoff-"));
  const previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = join(dir, "home");
  mkdirSync(join(dir, ".devctl"), { recursive: true });
  const config = join(dir, ".devctl", "config.yaml");
  writeFileSync(config, `version: 1
shutdown:
  grace_seconds: 1
services:
  api:
    command: [${JSON.stringify(process.execPath)}, "-e", "setInterval(() => {}, 1000)"]
`);
  const originalArgv1 = process.argv[1] ?? "";
  process.argv[1] = join(import.meta.dir, "../bin.ts");
  let service = 0;
  let daemon = 0;
  try {
    await run(["--config", config, "start", "api", "--detach"]);
    service = readPersistedState(dir)?.processes.find((row) => row.name === "api")?.pid ?? 0;
    daemon = readRepoLock(dir)?.pid ?? 0;
    expect(service).toBeGreaterThan(0);
    expect(await until(() => readHeartbeat(dir)?.pid === daemon, 5_000)).toBe(true);
    writeRestartRequest(dir, { pid: daemon, session: readHeartbeat(dir)?.session ?? "" });
    process.kill(daemon, "SIGTERM");
    expect(await until(() => !processAlive(daemon), 10_000)).toBe(true);
    expect(processAlive(service)).toBe(true);
    expect(readPersistedState(dir)?.processes.find((row) => row.name === "api")?.pid).toBe(service);
  } finally {
    process.argv[1] = originalArgv1;
    for (const pid of [service, daemon]) {
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    if (previousHome === undefined) {
      delete process.env.DEVCTL_HOME;
    } else {
      process.env.DEVCTL_HOME = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
