import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { newRoot } from "./cli.ts";
import { processAlive, readPersistedState } from "./storage.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(join(dir, ".devctl"), { recursive: true });
  process.env.DEVCTL_HOME = join(dir, "home");
  return dir;
}

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function run(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    await newRoot().parseAsync(["node", "devctl", ...args], { from: "node" });
  } finally {
    cap.restore();
  }
  return cap.output();
}

// start needs a real config, addressed via the existing global --config
// flag; down/status target a repository directly via the new --repo flag
// and must work without ever loading one.
function configFile(dir: string): string {
  return join(dir, ".devctl", "config.yaml");
}

describe("devctl down", () => {
  test("reports when no supervisor is running instead of erroring", async () => {
    const dir = tmp();
    writeFileSync(configFile(dir), "version: 1\nservices:\n  api:\n    command: [echo, ok]\n");
    const out = await run(["down", "--repo", dir]);
    expect(out).toContain("no supervisor is running");
  });

  test("stops services and the daemon by default", async () => {
    const dir = tmp();
    writeFileSync(
      configFile(dir),
      `version: 1
shutdown:
  grace_seconds: 1
services:
  api:
    command: [${JSON.stringify(process.execPath)}, "-e", "setInterval(() => {}, 1000)"]
`,
    );
    // ensureSupervisor spawns [execPath, argv[1], "_supervisor", ...] in
    // source mode; under bun test argv[1] is the test runner's own entry,
    // not bin.ts, so point it at the real one for this one real subprocess.
    const originalArgv1 = process.argv[1] ?? "";
    process.argv[1] = join(import.meta.dir, "bin.ts");
    try {
      const startOut = await run(["--config", configFile(dir), "start", "api", "--detach"]);
      expect(startOut).toContain("detached");

      const downOut = await run(["down", "--repo", dir]);
      expect(downOut).toContain("stopped services and the supervisor");

      const statusOut = await run(["status", "--repo", dir]);
      expect(statusOut).toContain("supervisor is not running");
      const persisted = readPersistedState(dir);
      expect(persisted?.processes ?? []).toEqual([]);
    } finally {
      process.argv[1] = originalArgv1;
    }
  }, 20_000);

  test("--keep-services stops only the daemon, leaving the service running", async () => {
    const dir = tmp();
    writeFileSync(
      configFile(dir),
      `version: 1
shutdown:
  grace_seconds: 1
services:
  api:
    command: [${JSON.stringify(process.execPath)}, "-e", "setInterval(() => {}, 1000)"]
`,
    );
    const originalArgv1 = process.argv[1] ?? "";
    process.argv[1] = join(import.meta.dir, "bin.ts");
    let pid = 0;
    try {
      await run(["--config", configFile(dir), "start", "api", "--detach"]);
      const beforeDown = readPersistedState(dir);
      pid = beforeDown?.processes.find((p) => p.name === "api")?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);

      const downOut = await run(["down", "--repo", dir, "--keep-services"]);
      expect(downOut).toContain("its services keep running");

      const statusOut = await run(["status", "--repo", dir]);
      expect(statusOut).toContain("supervisor is not running");
      const afterDown = readPersistedState(dir);
      // The daemon is gone, but its last-persisted record must still show
      // the service as running (not cleared to an empty process list the
      // way a full `down` leaves it) — that's what makes it adoptable.
      expect(afterDown?.processes.find((p) => p.name === "api")?.pid).toBe(pid);
      expect(processAlive(pid)).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);
});
