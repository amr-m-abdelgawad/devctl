import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { followLogs, newRoot } from "./cli.ts";
import { type LogEvent, type LogPage } from "./logs.ts";
import { processAlive, readPersistedState } from "./storage.ts";

function tmp(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function captureStderr(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
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

describe("devctl start --detach", () => {
  test("--detach prints a deprecation warning; a plain start does not", async () => {
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
    try {
      const withDetach = captureStderr();
      await run(["--config", configFile(dir), "start", "api", "--detach"]);
      withDetach.restore();
      expect(withDetach.output()).toContain("--detach is deprecated");
      await run(["down", "--repo", dir]);

      const withoutDetach = captureStderr();
      await run(["--config", configFile(dir), "start", "api"]);
      withoutDetach.restore();
      expect(withoutDetach.output()).not.toContain("deprecated");
      await run(["down", "--repo", dir]);
    } finally {
      process.argv[1] = originalArgv1;
    }
  }, 20_000);
});

describe("devctl logs export", () => {
  test("resolves a relative --output path against the CLI's own cwd, not the long-running daemon's", async () => {
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
    const originalCwd = process.cwd();
    process.argv[1] = join(import.meta.dir, "bin.ts");
    const workDir = join(dir, "workdir");
    mkdirSync(workDir, { recursive: true });
    try {
      // The daemon is spawned while cwd is still the repo dir, so its own
      // cwd is fixed there for its whole lifetime.
      process.chdir(dir);
      await run(["--config", configFile(dir), "start", "api", "--detach"]);

      // A relative --output given after moving elsewhere must land next to
      // where the command was actually run, not wherever the daemon's cwd
      // happened to be frozen at spawn time.
      process.chdir(workDir);
      await run(["--config", configFile(dir), "logs", "export", "--output", "relative.log"]);

      expect(existsSync(join(workDir, "relative.log"))).toBe(true);
      expect(existsSync(join(dir, "relative.log"))).toBe(false);

      await run(["--config", configFile(dir), "down"]);
    } finally {
      process.chdir(originalCwd);
      process.argv[1] = originalArgv1;
    }
  }, 20_000);
});

describe("devctl status/down honor the global --config flag", () => {
  test("--config alone (no --repo) resolves the daemon, matching every other command", async () => {
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
    try {
      await run(["--config", configFile(dir), "start", "api", "--detach"]);

      const statusOut = await run(["--config", configFile(dir), "status"]);
      expect(statusOut).not.toContain("no devctl configuration found");
      expect(statusOut).not.toContain("supervisor is not running");
      expect(statusOut).toContain("api");

      const downOut = await run(["--config", configFile(dir), "down"]);
      expect(downOut).toContain("stopped services and the supervisor");
    } finally {
      process.argv[1] = originalArgv1;
    }
  }, 20_000);
});

describe("devctl status --watch piped into a reader that closes early", () => {
  test("exits cleanly on EPIPE instead of crashing with an uncaught exception", async () => {
    const dir = tmp();
    writeFileSync(configFile(dir), "version: 1\nservices:\n  api:\n    command: [echo, ok]\n");
    const binPath = join(import.meta.dir, "bin.ts");
    const originalArgv1 = process.argv[1] ?? "";
    process.argv[1] = binPath;
    try {
      await run(["--config", configFile(dir), "start", "api", "--detach"]);

      // A real bash pipe (not an in-process stream) so closing the reader
      // produces a genuine OS-level EPIPE on the writer's next write, the
      // same condition a real `devctl status --watch | head -1` hits.
      const script = `set -o pipefail; ${JSON.stringify(process.execPath)} ${JSON.stringify(binPath)} --config ${JSON.stringify(configFile(dir))} status --watch | head -1`;
      const proc = Bun.spawn({ cmd: ["bash", "-c", script], stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

      // head -1 only ever sees the very first line devctl wrote (the
      // "--- <timestamp> ---" tick header) before closing the pipe.
      expect(stdout).toMatch(/^--- .+ ---\n$/);
      expect(stderr).not.toContain("EPIPE");
      expect(exitCode).toBe(0);

      await run(["--config", configFile(dir), "down"]);
    } finally {
      process.argv[1] = originalArgv1;
    }
  }, 20_000);
});

function fakeLogEvent(message: string): LogEvent {
  return { timestamp: "2026-08-30T00:00:00.000Z", service: "api", source: "stdout", level: "INFO", message, pid: 1, seq: 1 };
}

function fakePage(events: LogEvent[], nextCursor: string, prevCursor = ""): LogPage {
  return { events, nextCursor, prevCursor, hasNext: false, hasPrev: false, sessionChanged: false };
}

describe("followLogs", () => {
  test("prints the first page, then advances the cursor on each subsequent poll without repeating events", async () => {
    const abort = new AbortController();
    let call = 0;
    const printed: string[] = [];
    const fetchPage = async (cursor?: string): Promise<LogPage> => {
      call += 1;
      if (call === 1) {
        expect(cursor).toBeUndefined();
        return fakePage([fakeLogEvent("one")], "c1");
      }
      if (call === 2) {
        expect(cursor).toBe("c1");
        return fakePage([fakeLogEvent("two")], "c2");
      }
      if (call === 3) {
        // Requires the cursor to have advanced a *second* time (from this
        // call's own predecessor's nextCursor, not just the very first
        // page's) — a cursor that only ever updates once would still pass
        // call 2's assertion but fail here.
        expect(cursor).toBe("c2");
        // The abort fires from inside this fetch (simulating "the user hit
        // ctrl+C while a poll was in flight") rather than from a real timer,
        // so the test has no wall-clock dependency: the event this call
        // returns must still be printed before the loop notices and stops,
        // but no 4th fetch should ever happen.
        abort.abort();
        return fakePage([fakeLogEvent("three")], "c3");
      }
      throw new Error(`fetchPage should not be called a 4th time (cursor=${cursor})`);
    };
    await followLogs(fetchPage, (ev) => printed.push(ev.message), abort.signal, 1);
    expect(printed).toEqual(["one", "two", "three"]);
    expect(call).toBe(3);
  });

  test("stops promptly when aborted mid-poll-wait, not at the next full interval", async () => {
    const abort = new AbortController();
    const fetchPage = async (): Promise<LogPage> => fakePage([], "c");
    const started = Date.now();
    const promise = followLogs(fetchPage, () => {}, abort.signal, 10_000);
    setTimeout(() => abort.abort(), 20);
    await promise;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("devctl daemon logs", () => {
  test("reports no bootstrap log yet for a repo whose daemon has never been spawned", async () => {
    const dir = tmp();
    writeFileSync(configFile(dir), "version: 1\nservices:\n  api:\n    command: [echo, ok]\n");
    const out = await run(["--config", configFile(dir), "daemon", "logs"]);
    expect(out).toContain("no daemon bootstrap log yet");
  });
});
