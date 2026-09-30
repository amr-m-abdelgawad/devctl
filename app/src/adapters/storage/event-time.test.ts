import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Bus, LogReceived } from "../../shared/events.ts";
import { Detector } from "../secrets/detector.ts";
import { OrderedSpool } from "./ingest/spool.ts";
import type { PipelineLimits } from "./ingest/pipeline.ts";
import { LogManager, logMessage, REQUEST_ID_ATTR, type LogRecord } from "./logs.ts";

const dirs: string[] = [];

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-evtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manager(name: string, pipelineLimits?: PipelineLimits, bus?: Bus): LogManager {
  const dir = tmp();
  return new LogManager(500, bus, new Detector([], []), false, dir, name, 0, 0, { spoolDir: join(dir, "spool"), pipelineLimits });
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(predicate()).toBe(true);
}

async function drained(mgr: LogManager): Promise<void> {
  await until(() => {
    const stats = mgr.pipelineStats();
    return stats === undefined || (stats.inFlightBytes === 0 && stats.spooledBytes === 0);
  });
}

function messages(records: LogRecord[], service: string): string[] {
  return records.filter((record) => record.service === service).map((record) => logMessage(record));
}

const T0 = Date.parse("2026-09-29T10:00:00.000Z");

// A traceback split mid-line across reads, then an indented line and another
// line read long after it. Read 300 ms later, the indented line is its own
// event live; a processor that went by arrival would fold it into the traceback.
const READS = [
  { at: T0, text: "Traceback (most recent call last):\n  File \"app.py\", li" },
  { at: T0 + 1, text: "ne 3, in <module>\n    boom()\nValueE" },
  { at: T0 + 2, text: "rror: boom\n" },
  { at: T0 + 300, text: "  an indented line read long after\n" },
  { at: T0 + 301, text: "INFO next request\n" },
];

const LIVE_FOLDS = [
  "Traceback (most recent call last):\n  File \"app.py\", line 3, in <module>\n    boom()\nValueError: boom",
  "  an indented line read long after",
  "INFO next request",
];

function offer(mgr: LogManager, service: string, read: { at: number; text: string }): boolean {
  return mgr.acceptChunk({ service, stream: "stdout", pid: 7, readAtMs: read.at, bytes: Buffer.from(read.text) });
}

describe("event-time folding", () => {
  test("a traceback split across chunks folds the same with and without a spill", async () => {
    const plain = manager("fold-plain");
    const spilled = manager("fold-spill", { spillPerStream: 8, spillTotal: 16, creditPerStream: 1 << 16, creditTotal: 1 << 17 });
    for (const read of READS) {
      expect(offer(plain, "api", read)).toBe(true);
      expect(offer(spilled, "api", read)).toBe(true);
    }
    expect(spilled.pipelineStats()?.spooledBytes).toBeGreaterThan(0);
    for (const mgr of [plain, spilled]) {
      await drained(mgr);
      await mgr.flush();
      expect(messages(mgr.query({}), "api")).toEqual(LIVE_FOLDS);
      await mgr.close();
    }
  });

  test("a chunk refused under backpressure and accepted after the idle timeout still folds", async () => {
    // No spool room, so a chunk past the memory credit is refused outright.
    const mgr = manager("fold-late", { spillPerStream: 64, spillTotal: 128, creditPerStream: 1_024, creditTotal: 256, spoolMaxBytes: 1 });
    expect(offer(mgr, "api", READS[0]!)).toBe(true);
    await until(() => mgr.pipelineStats()?.inFlightBytes === 0);
    // A noisy stream takes 232 of the 256 credit bytes before the next read gets in.
    for (let i = 0; i < 4; i += 1) {
      expect(offer(mgr, "noise", { at: T0 + 1, text: `noise ${String(i).padStart(3, "0")} ${"n".repeat(47)}\n` })).toBe(true);
    }
    expect(mgr.pipelineStats()?.inFlightBytes).toBe(232);
    expect(offer(mgr, "api", READS[1]!)).toBe(false);
    // Well past the 80 ms idle timeout by the wall clock, while the reader holds the refused chunk.
    await Bun.sleep(200);
    expect(offer(mgr, "api", READS[1]!)).toBe(true);
    for (const read of READS.slice(2)) {
      expect(offer(mgr, "api", read)).toBe(true);
    }
    await drained(mgr);
    await mgr.flush();
    expect(messages(mgr.query({}), "api")).toEqual(LIVE_FOLDS);
    expect(messages(mgr.query({}), "noise")).toHaveLength(4);
    await mgr.close();
  });

  test("a quiet stream's open line is still published by the wall clock", async () => {
    const bus = new Bus(16);
    const received: string[] = [];
    bus.subscribe((event) => {
      if (event.type === LogReceived) {
        received.push(logMessage(event.payload?.event as LogRecord));
      }
    });
    const mgr = manager("fold-quiet", undefined, bus);
    expect(offer(mgr, "api", { at: Date.now(), text: "Traceback (most recent call last):\n" })).toBe(true);
    await until(() => received.includes("Traceback (most recent call last):"));
    await mgr.close();
  });

  test("a query leaves a fold open while its stream still has output queued", async () => {
    const mgr = manager("fold-query");
    const now = Date.now();
    expect(offer(mgr, "api", { at: now, text: "Traceback (most recent call last):\n" })).toBe(true);
    await until(() => mgr.pipelineStats()?.inFlightBytes === 0);
    expect(offer(mgr, "api", { at: now + 1, text: "  File \"app.py\", line 1\nValueError: x\n" })).toBe(true);
    // The continuation is queued, not yet parsed: the query must not split the traceback.
    expect(messages(mgr.query({}), "api")).toEqual([]);
    await drained(mgr);
    await mgr.flush();
    expect(messages(mgr.query({}), "api")).toEqual(["Traceback (most recent call last):\n  File \"app.py\", line 1\nValueError: x"]);
    await mgr.close();
  });

  test("replayed spool lines fold by the time they were read", async () => {
    const dir = tmp();
    const spoolDir = join(dir, "spool");
    const crashed = new OrderedSpool(join(spoolDir, "crashed_api_stdout_4"));
    const header = { session: "crashed", service: "api", stream: "stdout", pid: 4 };
    expect(crashed.append(header, [{ readAtMs: T0, bytes: Buffer.from("Traceback (most recent call last):\n  File") }])).toBe("ok");
    expect(crashed.append(header, [
      { readAtMs: T0 + 1, bytes: Buffer.from(" \"a.py\", line 1\nValueError: x\n") },
      { readAtMs: T0 + 5_000, bytes: Buffer.from("  indented, read five seconds later\n") },
    ])).toBe("ok");
    const mgr = new LogManager(500, undefined, new Detector([], []), false, dir, "replayer", 0, 0, { spoolDir });
    await mgr.replayDone();
    await mgr.flush();
    expect(messages(mgr.query({}), "api")).toEqual([
      "Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError: x",
      "  indented, read five seconds later",
    ]);
    await mgr.close();
  });
});

describe("event-time proxy-hop pairing", () => {
  test("a hop pairs with a service line that was still queued when the hop arrived", async () => {
    const mgr = manager("hop-lag");
    // Parsing is slow enough that the line ahead of the hop commits well after it.
    mgr.setParsers([{ name: "slow", parse: () => {
      Bun.sleepSync(1);
      return undefined;
    } }]);
    const readAt = Date.now();
    const filler = Array.from({ length: 120 }, (_, i) => `filler ${i}`).join("\n");
    expect(offer(mgr, "worker", { at: readAt, text: `${filler}\nERROR temporalio_client::retry: gRPC call poll_activity_task_queue retried 41 times\n` })).toBe(true);
    mgr.append({
      timestamp: new Date(readAt + 5).toISOString(),
      service: "proxy",
      source: "proxy",
      level: "WARN",
      message: "grpc /temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue route=temporal-grpc grpc-status=14",
      pid: 0,
      request_id: "req-lagging",
    }, readAt + 5);
    await drained(mgr);
    await mgr.flush();
    const worker = mgr.query({}).find((event) => event.service === "worker" && logMessage(event).includes("retried"));
    expect(worker?.attributes[REQUEST_ID_ATTR]).toBe("req-lagging");
    expect(Date.now() - readAt).toBeGreaterThan(100);
    await mgr.close();
  });
});
