import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { available } from "../net/ports.ts";
import { ProcessManager, sameAdoptedProcess, sameProcess, sampleResourceUsage } from "./processes.ts";
import { parseElapsedMillis } from "./unix.ts";

function listenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") {
          resolve(addr.port);
          return;
        }
        reject(new Error("no port"));
      });
    });
    server.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("sameProcess", () => {
  test("requires command and cwd and startTime when both are present", () => {
    const now = new Date();
    expect(
      sameProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { pid: 1, command: "python main.py", cwd: "/repo", startTime: now.toISOString() },
      ),
    ).toBe(true);
    expect(
      sameProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { pid: 1, command: "python main.py", cwd: "/other", startTime: now.toISOString() },
      ),
    ).toBe(false);
    expect(
      sameProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { pid: 1, command: "python main.py", cwd: "/repo", startTime: new Date(now.getTime() + 10_000).toISOString() },
      ),
    ).toBe(false);
    expect(
      sameProcess(
        { args: ["python", "main.py"], workDir: "", startTime: now },
        { pid: 1, command: "python main.py", cwd: "/repo", startTime: now.toISOString() },
      ),
    ).toBe(true);
  });
});

describe("sameAdoptedProcess", () => {
  test("accepts a start time that drifted backward and rejects a newer pid", () => {
    const now = new Date();
    const observed = { pid: 1, command: "python main.py", cwd: "/repo" };
    expect(
      sameAdoptedProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { ...observed, startTime: new Date(now.getTime() + 10_000).toISOString() },
      ),
    ).toBe(true);
    expect(
      sameAdoptedProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { ...observed, startTime: new Date(now.getTime() + 120_000).toISOString() },
      ),
    ).toBe(false);
    expect(
      sameAdoptedProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { ...observed, startTime: new Date(now.getTime() - 60 * 60 * 1000).toISOString() },
      ),
    ).toBe(true);
    expect(
      sameAdoptedProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { ...observed, cwd: "/other", startTime: now.toISOString() },
      ),
    ).toBe(false);
    expect(
      sameAdoptedProcess(
        { args: ["python", "main.py"], workDir: "/repo", startTime: now },
        { ...observed, command: "node server.js", startTime: now.toISOString() },
      ),
    ).toBe(false);
  });
});

describe("Unix elapsed process time", () => {
  test("parses ps etime without depending on a timezone", () => {
    expect(parseElapsedMillis("  04:05 ")).toBe((4 * 60 + 5) * 1000);
    expect(parseElapsedMillis("02:03:04")).toBe(((2 * 60 + 3) * 60 + 4) * 1000);
    expect(parseElapsedMillis("3-02:03:04")).toBe((((3 * 24 + 2) * 60 + 3) * 60 + 4) * 1000);
    expect(parseElapsedMillis("not-a-duration")).toBeUndefined();
  });
});

describe("process adopt", () => {
  test("adopt attaches a live pid so stop can signal it", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 1e6)"],
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const mgr = new ProcessManager();
    mgr.adopt({
      name: "orphan",
      pid,
      args: [process.execPath],
      workDir: process.cwd(),
      startTime: new Date(),
    });
    expect(mgr.get("orphan")?.pid).toBe(pid);
    await mgr.stop("orphan", 800);
    await sleep(100);
    expect(mgr.get("orphan")).toBeUndefined();
  });
});

describe("process stop", () => {
  test("stop kills grandchild listeners so the port is free", async () => {
    const port = await listenPort();
    const mgr = new ProcessManager();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    await mgr.start({
      name: "holder",
      args: [
        process.execPath,
        "-e",
        `require("node:net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1e6)`,
      ],
      shell: false,
      workDir: "",
      env,
      graceMs: 800,
    });
    let held = false;
    for (let i = 0; i < 40; i += 1) {
      if (!(await available(port))) {
        held = true;
        break;
      }
      await sleep(50);
    }
    expect(held).toBe(true);
    await mgr.stop("holder", 800);
    let freed = false;
    for (let i = 0; i < 40; i += 1) {
      if (await available(port)) {
        freed = true;
        break;
      }
      await sleep(50);
    }
    expect(freed).toBe(true);
  });
});

describe("sampleResourceUsage", () => {
  test("reports cpu and memory for a live pid", async () => {
    if (process.platform === "win32") {
      return;
    }
    const samples = await sampleResourceUsage([process.pid]);
    const self = samples.get(process.pid);
    expect(self).toBeDefined();
    expect(self?.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(self?.memoryKB).toBeGreaterThan(0);
  });

  test("returns an empty map for no pids", async () => {
    const samples = await sampleResourceUsage([]);
    expect(samples.size).toBe(0);
  });
});

test("runOnce captures output without registering a managed process", async () => {
  const mgr = new ProcessManager();
  const result = await mgr.runOnce({ name: "once", args: [process.execPath, "-e", "console.log('out'); console.error('err')"], shell: false, workDir: "", env: process.env as Record<string, string>, graceMs: 1000 });
  expect(result).toEqual({ code: 0, stdout: "out\n", stderr: "err\n" });
  expect(mgr.all()).toHaveLength(0);
});

test("runOnce caps captured stdout and forwards every line to onLine", async () => {
  const mgr = new ProcessManager();
  const lines: number[] = [];
  // Emit ~2 MiB of stdout in 64 KiB chunks so the capture exceeds the 1 MiB cap.
  const script = "const c='x'.repeat(65536);for(let i=0;i<32;i++)console.log(c)";
  const result = await mgr.runOnce({
    name: "noisy",
    args: [process.execPath, "-e", script],
    shell: false,
    workDir: "",
    env: process.env as Record<string, string>,
    graceMs: 1000,
    onLine: (stream) => {
      if (stream === "stdout") lines.push(1);
    },
  });
  expect(result.code).toBe(0);
  // Captured string is capped (cap + one final line + marker), well under the ~2 MiB emitted.
  expect(result.stdout.length).toBeLessThan(1024 * 1024 + 128 * 1024);
  expect(result.stdout.endsWith("\n...[truncated]\n")).toBe(true);
  // Live logging is untouched: every emitted line reached onLine.
  expect(lines.length).toBe(32);
});

test("runOnce bounds a single unterminated line without dropping callbacks", async () => {
  const mgr = new ProcessManager();
  let onLineCalls = 0;
  // ~2.1 MiB written with no trailing newline — the line pump must force-break
  // it so the pending buffer cannot grow without bound.
  const script = "process.stdout.write('x'.repeat(2_100_000))";
  const result = await mgr.runOnce({
    name: "flood",
    args: [process.execPath, "-e", script],
    shell: false,
    workDir: "",
    env: process.env as Record<string, string>,
    graceMs: 1000,
    onLine: () => {
      onLineCalls += 1;
    },
  });
  expect(result.code).toBe(0);
  // Captured output stays bounded near the 1 MiB cap despite the ~2.1 MiB flood.
  expect(result.stdout.length).toBeLessThan(1024 * 1024 + 128 * 1024);
  // The forced line break(s) still reached onLine at least once.
  expect(onLineCalls).toBeGreaterThan(0);
});
