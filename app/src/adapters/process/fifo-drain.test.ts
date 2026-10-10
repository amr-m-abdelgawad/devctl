import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";
import { drainCommand, replayDrained, startDrain, type DrainPlan } from "./fifo-drain.ts";
import { fifoChunks, probeFifoWatch } from "./fifo-reader.ts";

// Where a watch reports FIFO writes (Linux), the plans below name the FIFO, as a daemon's plan does there.
const probeDir = mkdtempSync(join(tmpdir(), "devctl-drain-probe-"));
const WATCHABLE = process.platform !== "win32" && (await probeFifoWatch(probeDir));
rmSync(probeDir, { recursive: true, force: true });

const dirs: string[] = [];
const kids: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const kid of kids.splice(0)) {
    kid.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Service = { dir: string; fifo: string; readFd: number; proc: ReturnType<typeof Bun.spawn> };

// A service whose stdout is a FIFO it holds O_RDWR, as ProcessManager starts it.
function serviceWritingTo(script: string): Service {
  const dir = mkdtempSync(join(tmpdir(), "devctl-drain-"));
  dirs.push(dir);
  const fifo = join(dir, "stdout.fifo");
  expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
  const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const serviceEnd = openSync(fifo, constants.O_RDWR);
  const proc = Bun.spawn({ cmd: ["/bin/sh", "-c", script], stdout: serviceEnd, stderr: "ignore" });
  closeSync(serviceEnd);
  kids.push(proc);
  return { dir, fifo, readFd, proc };
}

function planFor(service: Service, maxBytes: number, fd = service.readFd): DrainPlan {
  return {
    spoolDir: join(service.dir, "drain"),
    maxBytes,
    stoppedPath: join(service.dir, "drain.stopped"),
    streams: [{ fd, service: "api", stream: "stdout", pid: service.proc.pid, fifo: WATCHABLE ? service.fifo : undefined }],
  };
}

type Delivery = { text: string; readAtMs?: number; end?: boolean; pid?: number };

async function replayAll(spoolDir: string): Promise<Delivery[]> {
  const got: Delivery[] = [];
  const handler: ProcessChunkHandler = (_stream, bytes, meta) => {
    got.push({ text: Buffer.from(bytes).toString("utf8"), readAtMs: meta?.readAtMs, end: meta?.end, pid: meta?.pid });
    return true;
  };
  await replayDrained(spoolDir, (service) => (service === "api" ? handler : undefined));
  return got;
}

async function readRest(fifo: string): Promise<string> {
  const fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  let text = "";
  for await (const chunk of fifoChunks(fd)) {
    text += Buffer.from(chunk).toString("utf8");
  }
  closeSync(fd);
  return text;
}

function spoolBytes(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) : 0;
}

function numbered(text: string): number[] {
  return text.trimEnd().split("\n").map((line) => Number(line.slice("line-".length)));
}

const LINES = 150_000;
const writeLines = `i=1; while [ $i -le ${LINES} ]; do echo line-$i; i=$((i+1)); done`;
const expected = Array.from({ length: LINES }, (_, i) => i + 1);

describe.skipIf(process.platform === "win32")("fifo drain", () => {
  test("a full drain spool blocks the writer instead of dropping output", async () => {
    const service = serviceWritingTo(writeLines);
    const cap = 64 * 1024;
    const plan = planFor(service, cap);
    const drain = startDrain(plan);
    await Bun.sleep(800);
    // ~1.7 MB of output against a 64 KiB cap: the writer is parked, not finished or killed.
    expect(service.proc.exitCode).toBeNull();
    drain.stop();
    await drain.done;
    expect(existsSync(plan.stoppedPath)).toBe(true);
    // At most one read batch past the cap, plus segment headers.
    expect(spoolBytes(plan.spoolDir)).toBeLessThan(cap + 256 * 1024 + 4 * 1024);
    const replayed = await replayAll(plan.spoolDir);
    expect(replayed.some((d) => d.end === true)).toBe(false);
    const rest = await readRest(service.fifo);
    expect(await service.proc.exited).toBe(0);
    expect(numbered(replayed.map((d) => d.text).join("") + rest)).toEqual(expected);
    expect(spoolBytes(plan.spoolDir)).toBe(0);
  }, 30_000);

  test("the drain spool and the dead daemon's ingest spool share one cap", async () => {
    const service = serviceWritingTo(writeLines);
    // The dead daemon left 48 KiB of unparsed output in its own spool.
    const ingestSpoolDir = join(service.dir, "log-spool");
    mkdirSync(join(ingestSpoolDir, "s_api_stdout_1"), { recursive: true });
    writeFileSync(join(ingestSpoolDir, "s_api_stdout_1", "00000000.spool"), Buffer.alloc(48 * 1024));
    const plan = { ...planFor(service, 64 * 1024), ingestSpoolDir };
    const drain = startDrain(plan);
    await Bun.sleep(800);
    expect(service.proc.exitCode).toBeNull();
    drain.stop();
    await drain.done;
    // 16 KiB was left for the drainer; it stops within one read batch of that, far below its own 64 KiB.
    expect(spoolBytes(plan.spoolDir)).toBeLessThan(48 * 1024);
    const replayed = await replayAll(plan.spoolDir);
    const rest = await readRest(service.fifo);
    expect(await service.proc.exited).toBe(0);
    expect(numbered(replayed.map((d) => d.text).join("") + rest)).toEqual(expected);
  }, 30_000);

  test("replay marks its chunks and reports what the spool still holds", async () => {
    const service = serviceWritingTo("echo one; echo two");
    const plan = planFor(service, 1 << 20);
    const drain = startDrain(plan);
    await service.proc.exited;
    await Bun.sleep(300);
    drain.stop();
    await drain.done;
    const remaining: number[] = [];
    const replayedFlags: (boolean | undefined)[] = [];
    const handler: ProcessChunkHandler = (_stream, _bytes, meta) => {
      if (meta?.end !== true) {
        replayedFlags.push(meta?.replayed);
      }
      return true;
    };
    await replayDrained(plan.spoolDir, () => handler, (bytes) => remaining.push(bytes));
    expect(replayedFlags.length).toBeGreaterThan(0);
    expect(replayedFlags.every((flag) => flag === true)).toBe(true);
    expect(remaining[0]).toBeGreaterThan(0);
    expect(remaining.at(-1)).toBe(0);
  }, 30_000);

  test("replay keeps each chunk's read time and pid, then ends the stream", async () => {
    const service = serviceWritingTo("printf 'first\\n'; sleep 0.3; printf 'second\\nno newline'");
    const plan = planFor(service, 1024 * 1024);
    const before = Date.now();
    const drain = startDrain(plan);
    await drain.done;
    const replayed = await replayAll(plan.spoolDir);
    expect(replayed.filter((d) => d.end !== true).map((d) => d.text).join("")).toBe("first\nsecond\nno newline");
    expect(replayed.at(-1)?.end).toBe(true);
    const times = replayed.filter((d) => d.end !== true).map((d) => d.readAtMs ?? 0);
    expect(times[0]).toBeGreaterThanOrEqual(before);
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(250);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(replayed.filter((d) => d.end !== true).every((d) => d.pid === service.proc.pid)).toBe(true);
  });

  test("a drainer asleep on a quiet FIFO reads the next output when it comes, and nothing once it is stopped", async () => {
    const service = serviceWritingTo("printf a; sleep 0.6; printf b; sleep 1.2; printf late; sleep 0.2");
    const plan = planFor(service, 1024 * 1024);
    const drain = startDrain(plan);
    await Bun.sleep(1_100);
    drain.stop();
    await drain.done;
    expect(await service.proc.exited).toBe(0);
    const replayed = await replayAll(plan.spoolDir);
    expect(replayed.map((d) => d.text)).toEqual(["a", "b"]);
    // "b" was read when it was written, after the quiet spell, not when the drainer stopped.
    const gap = (replayed[1]?.readAtMs ?? 0) - (replayed[0]?.readAtMs ?? 0);
    expect(gap).toBeGreaterThanOrEqual(450);
    expect(gap).toBeLessThan(900);
    expect(await readRest(service.fifo)).toBe("late");
  });

  test("a plan too long for one argument goes to the drainer without the FIFO paths", () => {
    const stream = (index: number) => ({ fd: 3 + index, service: `service-${index}`, stream: "stdout" as const, pid: 40_000 + index, fifo: `/home/dev/.local/state/devctl/0123456789abcdef/stdio/fifo/service-${index}-41000-${index}.stdout` });
    const plan = (streams: number): DrainPlan => ({ spoolDir: "/state/stdio/drain", maxBytes: 1 << 30, stoppedPath: "/state/stdio/drain.stopped", streams: Array.from({ length: streams }, (_, index) => stream(index)) });
    const few = JSON.parse(drainCommand(plan(40)).at(-1) ?? "") as DrainPlan;
    expect(few.streams.every((s) => typeof s.fifo === "string")).toBe(true);
    const arg = drainCommand(plan(1_200)).at(-1) ?? "";
    const many = JSON.parse(arg) as DrainPlan;
    expect(many.streams).toHaveLength(1_200);
    expect(many.streams.some((s) => s.fifo !== undefined)).toBe(false);
    expect(many.streams[7]).toEqual({ fd: 10, service: "service-7", stream: "stdout", pid: 40_007 });
    // Linux refuses an argument of 128 KiB or more.
    expect(Buffer.byteLength(arg)).toBeLessThan(128 * 1024);
  });

  test("the _drain process writes what it read when SIGTERM stops it, and the FIFO keeps the rest", async () => {
    const service = serviceWritingTo(writeLines);
    const plan = planFor(service, 64 * 1024, 3);
    const drainer = Bun.spawn({ cmd: drainCommand(plan), stdio: ["ignore", "ignore", "inherit", service.readFd] });
    kids.push(drainer);
    closeSync(service.readFd);
    const deadline = Date.now() + 10_000;
    while (spoolBytes(plan.spoolDir) === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    drainer.kill("SIGTERM");
    expect(await drainer.exited).toBe(0);
    expect(existsSync(plan.stoppedPath)).toBe(true);
    const replayed = await replayAll(plan.spoolDir);
    const rest = await readRest(service.fifo);
    expect(numbered(replayed.map((d) => d.text).join("") + rest)).toEqual(expected);
  }, 30_000);
});
