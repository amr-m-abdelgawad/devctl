import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";
import { FifoStdio } from "./fifo-stdio.ts";
import { ProcessManager } from "./processes.ts";

const PROCESSES_MODULE = fileURLToPath(new URL("./processes.ts", import.meta.url));
const dirs: string[] = [];
const kids: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const kid of kids.splice(0)) {
    kid.kill("SIGKILL");
  }
  // Let a pending sentinel refresh stand the last sentinel down before its directory goes.
  await Bun.sleep(50);
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "devctl-stdio-"));
  dirs.push(root);
  return root;
}

type Delivery = { stream: string; text: string; readAtMs: number; end: boolean };

function recorder(into: Delivery[]): ProcessChunkHandler {
  return (stream, bytes, meta) => {
    into.push({
      stream,
      text: Buffer.from(bytes).toString("utf8"),
      readAtMs: meta?.readAtMs ?? Date.now(),
      end: meta?.end === true,
    });
    return true;
  };
}

function textOf(deliveries: Delivery[], stream = "stdout"): string {
  return deliveries.filter((d) => d.stream === stream).map((d) => d.text).join("");
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  return check();
}

async function startThrough(stdio: FifoStdio, script: string, capture = { stdout: true, stderr: true }, into: Delivery[] = []): Promise<ReturnType<typeof Bun.spawn>> {
  const fifos = await stdio.open("api", capture);
  expect(fifos).toBeDefined();
  const proc = Bun.spawn({
    cmd: ["/bin/sh", "-c", script],
    stdout: fifos!.stdoutFd ?? "ignore",
    stderr: fifos!.stderrFd ?? "ignore",
  });
  kids.push(proc);
  fifos!.attach(proc.pid, recorder(into));
  return proc;
}

function numbered(text: string): number[] {
  return text.trimEnd().split("\n").map((line) => Number(line.slice("line-".length)));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe.skipIf(process.platform === "win32")("fifo stdio", () => {
  test("service output reaches the daemon through its FIFOs, and each stream ends when the service exits", async () => {
    const root = tempRoot();
    const stdio = new FifoStdio(root, 1024 * 1024);
    const got: Delivery[] = [];
    const proc = await startThrough(stdio, "echo out; echo err >&2; printf 'tail'", undefined, got);
    expect(await proc.exited).toBe(0);
    expect(await waitFor(() => got.filter((d) => d.end).length === 2, 5_000)).toBe(true);
    expect(textOf(got)).toBe("out\ntail");
    expect(textOf(got, "stderr")).toBe("err\n");
    expect(stdio.follows(proc.pid)).toBe(false);
    expect(readdirSync(join(root, "fifo"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "streams.json"), "utf8"))).toEqual([]);
  });

  test("only captured streams get a FIFO", async () => {
    const root = tempRoot();
    const stdio = new FifoStdio(root, 1024 * 1024);
    const fifos = await stdio.open("api", { stdout: true, stderr: false });
    expect(fifos?.stdoutFd).toBeGreaterThan(2);
    expect(fifos?.stderrFd).toBeUndefined();
    expect(readdirSync(join(root, "fifo")).map((name) => name.split(".").at(-1))).toEqual(["stdout"]);
    fifos!.abandon();
    expect(readdirSync(join(root, "fifo"))).toEqual([]);
    expect(await stdio.open("api", { stdout: false, stderr: false })).toBeUndefined();
  });

  test("timers keep running while a service floods its FIFO", async () => {
    const root = tempRoot();
    const stdio = new FifoStdio(root, 1024 * 1024);
    const got: Delivery[] = [];
    let seenWhenTimerFired = -1;
    const proc = await startThrough(stdio, "head -c 8388608 /dev/zero", { stdout: true, stderr: false }, got);
    setTimeout(() => {
      seenWhenTimerFired = got.reduce((sum, d) => sum + d.text.length, 0);
    }, 0);
    await proc.exited;
    expect(await waitFor(() => got.some((d) => d.end), 10_000)).toBe(true);
    expect(seenWhenTimerFired).toBeGreaterThanOrEqual(0);
    expect(seenWhenTimerFired).toBeLessThan(8 * 1024 * 1024);
  });

  test("a keep-services handoff stops reading without ending the stream, and the next daemon loses nothing", async () => {
    const root = tempRoot();
    const gate = join(root, "go");
    const first = new FifoStdio(root, 64 * 1024 * 1024);
    const before: Delivery[] = [];
    const script = `i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i+1)); done; while [ ! -f "${gate}" ]; do sleep 0.02; done; while [ $i -le 60000 ]; do echo line-$i; i=$((i+1)); done`;
    const proc = await startThrough(first, script, undefined, before);
    expect(await waitFor(() => textOf(before).includes("line-3000\n"), 10_000)).toBe(true);
    await first.handoff();
    writeFileSync(gate, "");
    const second = new FifoStdio(root, 64 * 1024 * 1024);
    const after: Delivery[] = [];
    const { replayed } = await second.takeOver(() => recorder(after));
    await replayed;
    expect(second.follows(proc.pid)).toBe(true);
    expect(await proc.exited).toBe(0);
    expect(await waitFor(() => after.some((d) => d.end && d.stream === "stdout"), 10_000)).toBe(true);
    expect(before.some((d) => d.end)).toBe(false);
    expect(numbered(textOf(before) + textOf(after))).toEqual(range(1, 60_000));
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("fifo stdio across a daemon SIGKILL", () => {
  // A stand-in daemon: a ProcessManager with FIFO stdio in its own process,
  // recording every chunk it is handed and the time it got it.
  function daemon(root: string, record: string, script: string): ReturnType<typeof Bun.spawn> {
    const code = [
      `import { appendFileSync } from "node:fs";`,
      `import { ProcessManager } from ${JSON.stringify(PROCESSES_MODULE)};`,
      `const [root, record, script] = process.argv.slice(1);`,
      `const procs = new ProcessManager({ stdioRoot: root, spoolMaxBytes: 64 * 1024 * 1024 });`,
      `const handle = await procs.start({ name: "api", args: ["/bin/sh", "-c", script], shell: false, workDir: "", env: process.env, graceMs: 1000,`,
      `  onChunk: (stream, bytes, meta) => { appendFileSync(record, JSON.stringify({ stream, text: Buffer.from(bytes).toString("utf8"), readAtMs: meta?.readAtMs ?? Date.now(), end: meta?.end === true }) + "\\n"); return true; } });`,
      `console.log("started " + handle.pid);`,
      `setInterval(() => undefined, 60_000);`,
    ].join("\n");
    const proc = Bun.spawn({ cmd: [process.execPath, "-e", code, root, record, script], stdout: "ignore", stderr: "inherit" });
    kids.push(proc);
    return proc;
  }

  function recorded(record: string): Delivery[] {
    return existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Delivery) : [];
  }

  function spoolBytes(dir: string): number {
    return existsSync(dir) ? readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) : 0;
  }

  test("output written while no daemon runs is drained, replayed in order with its read times, then read live", async () => {
    const root = tempRoot();
    const record = join(root, "first-daemon.jsonl");
    const drain = join(root, "drain");
    const mark = (name: string): string => join(root, name);
    const script = [
      "i=1",
      "emit() { while [ $i -le $1 ]; do echo line-$i; i=$((i+1)); done; }",
      "emit 2000",
      `while [ ! -f "${mark("phase2")}" ]; do sleep 0.02; done`,
      "emit 100000",
      `: > "${mark("phase2-written")}"`,
      // Phase 3 runs until told to stop, through the drainer's stop and the takeover.
      `while [ ! -f "${mark("stop")}" ]; do emit $((i + 499)); done`,
    ].join("\n");
    const first = daemon(root, record, script);
    expect(await waitFor(() => textOf(recorded(record)).includes("line-2000\n"), 15_000)).toBe(true);
    // Phase 1 is fully ingested: nothing is in flight when the daemon dies.
    first.kill("SIGKILL");
    await first.exited;
    writeFileSync(mark("phase2"), "");
    // ~1.1 MB against an 8-64 KiB FIFO: the service only gets through phase 2 if the drainer took over.
    expect(await waitFor(() => existsSync(mark("phase2-written")), 20_000)).toBe(true);
    // Past what phase 2 can still have in the FIFO and in unflushed frames: the drainer is reading phase 3.
    const atPhase2 = spoolBytes(drain);
    expect(await waitFor(() => spoolBytes(drain) > atPhase2 + 512 * 1024, 20_000)).toBe(true);
    const next = new ProcessManager({ stdioRoot: root, spoolMaxBytes: 64 * 1024 * 1024 });
    const after: Delivery[] = [];
    const { replayed } = await next.takeOverStdio(() => recorder(after));
    // The drainer has stopped: anything read later was read live by this daemon.
    const drainerStoppedAt = Date.now();
    await replayed;
    expect(readdirSync(drain)).toEqual([]);
    expect(await waitFor(() => after.some((d) => !d.end && d.readAtMs > drainerStoppedAt), 20_000)).toBe(true);
    writeFileSync(mark("stop"), "");
    expect(await waitFor(() => after.some((d) => d.end && d.stream === "stdout"), 30_000)).toBe(true);
    const all = [...recorded(record), ...after];
    const lines = numbered(textOf(all));
    expect(lines.length).toBeGreaterThan(102_000);
    expect(lines).toEqual(range(1, lines.length));
    const times = all.filter((d) => !d.end).map((d) => d.readAtMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(after.some((d) => !d.end && d.readAtMs < drainerStoppedAt)).toBe(true);
  }, 60_000);
});
