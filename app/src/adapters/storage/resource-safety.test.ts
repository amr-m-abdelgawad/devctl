import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideLiveness, heartbeatWorkerAdvanced, LEGACY_DAEMON_MESSAGE, livenessActionKills } from "../../domain/daemon/liveness.ts";
import { memoryPressure, nextMemoryGuard } from "../../domain/daemon/memory-guard.ts";
import { diskReserveBytes } from "../../domain/logs/budgets.ts";
import { logBatchWire } from "../../domain/logs/batch.ts";
import { autoRingBytes } from "../../domain/logs/budgets.ts";
import { LineSplitter } from "./ingest/line-splitter.ts";
import { IngestPipeline } from "./ingest/pipeline.ts";
import { decodeSegment, encodeSegment, OrderedSpool } from "./ingest/spool.ts";
import { parseProcPgid, parseProcPpid, parseProcStatState, procStateKind } from "../process/liveness.ts";
import { wedgePath } from "../daemon/heartbeat.ts";
import { replayDrained, startDrain } from "../process/fifo-drain.ts";
import { FifoStdio } from "../process/fifo-stdio.ts";
import { enableChildSubreaper, reapOrphanedChildren } from "../process/subreaper.ts";
import { eventLoopLagMs, noteEventLoopLag } from "../daemon/resource-probe.ts";
import { LogManager } from "./logs.ts";
import { SessionLogWriter } from "./log-persist.ts";

describe("liveness decision", () => {
  test("a dead pid is replaced and an older daemon is not", () => {
    expect(decideLiveness({ process: "dead", identityMatches: true, lockGeneration: 1 })).toBe("spawn");
    expect(livenessActionKills("spawn")).toBe(true);
    expect(livenessActionKills("wait-busy")).toBe(false);
    expect(decideLiveness({ process: "zombie", identityMatches: true, lockGeneration: 2 })).toBe("spawn");
    expect(decideLiveness({ process: "alive", identityMatches: true, lockGeneration: 1 })).toBe("leave-legacy");
    expect(LEGACY_DAEMON_MESSAGE).toContain("devctl down --force");
    expect(logBatchWire({ session: "s", firstSeq: 1, lastSeq: 1, newest: [], replaced: [], skipped: 0, stats: { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 } })).toContain("\"session\":\"s\"");
  });

  test("a ticking daemon with a slow socket is waited on, and a 60s stall is a wedge", () => {
    const heartbeat = {
      pid: 1,
      identity: "1",
      session: "s",
      workerTick: 10,
      mainStallTicks: 0,
      rpcOkAgeTicks: 3,
    };
    expect(decideLiveness({ process: "alive", identityMatches: true, lockGeneration: 2, heartbeat, workerAdvanced: true })).toBe("wait-busy");
    expect(decideLiveness({
      process: "alive",
      identityMatches: true,
      lockGeneration: 2,
      heartbeat: { ...heartbeat, mainStallTicks: 60, rpcOkAgeTicks: 60 },
      workerAdvanced: true,
    })).toBe("replace-wedge");
    expect(decideLiveness({
      process: "alive",
      identityMatches: true,
      lockGeneration: 2,
      heartbeat: { ...heartbeat, rpcOkAgeTicks: 31 },
      workerAdvanced: true,
    })).toBe("graceful-restart");
    expect(decideLiveness({
      process: "alive",
      identityMatches: true,
      lockGeneration: 2,
      heartbeat,
      workerAdvanced: false,
    })).toBe("wait-frozen");
    const now = 10_000;
    expect(heartbeatWorkerAdvanced({ writtenAtMs: now - 1_000 }, now)).toBe(true);
    expect(heartbeatWorkerAdvanced({ writtenAtMs: now - 1_000, degraded: true }, now)).toBe(true);
    expect(heartbeatWorkerAdvanced({ writtenAtMs: now - 30_000 }, now)).toBe(false);
    expect(memoryPressure(80, 100)).toBe("shrink");
    expect(memoryPressure(95, 100)).toBe("shed");
    expect(memoryPressure(10, 100)).toBe("ok");
    expect(nextMemoryGuard("shrink", 0.7)).toBe("shrink");
    expect(nextMemoryGuard("shed", 0.8)).toBe("shed");
    expect(nextMemoryGuard("shed", 0.7)).toBe("shrink");
    expect(nextMemoryGuard("shrink", 0.5)).toBe("ok");
    expect(diskReserveBytes(100)).toBeGreaterThan(0);
  });
});

describe("line splitter", () => {
  test("folds CRLF, caps a huge line, and keeps CJK boundaries", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(Buffer.from("a\r\nb"))).toEqual(["a"]);
    expect(splitter.finish()).toEqual(["b"]);
    const huge = Buffer.alloc(80 * 1024, 0x61);
    const long = new LineSplitter();
    const lines = long.push(huge);
    expect(lines[0]?.length).toBe(16 * 1024);
    expect(long.push(Buffer.from("\nok\n"))).toEqual(["ok"]);
    const cjk = "你".repeat(20_000);
    const wide = new LineSplitter();
    const out = wide.push(Buffer.from(`${cjk}\n`));
    expect(out[0]?.length).toBe(16 * 1024);
  });
});

describe("ordered spool", () => {
  test("round-trips frames in order and deletes them on consume", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-spool-"));
    try {
      const spool = new OrderedSpool(dir, 1024 * 1024);
      expect(spool.append({ session: "s", service: "api", stream: "stdout", pid: 1 }, [
        { readAtMs: 1, bytes: Buffer.from("one") },
        { readAtMs: 2, bytes: Buffer.from("two") },
      ])).toBe("ok");
      const segment = spool.consumeNext();
      expect(segment?.header?.service).toBe("api");
      expect(segment?.frames.map((frame) => frame.bytes.toString("utf8"))).toEqual(["one", "two"]);
      expect(spool.consumeNext()).toBeUndefined();
      expect(spool.size()).toBe(0);
      const encoded = encodeSegment({ session: "s", service: "api", stream: "stdout", pid: 1 }, [{ readAtMs: 5, bytes: Buffer.from("z") }]);
      expect(decodeSegment(encoded)[0]?.bytes.toString("utf8")).toBe("z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ingest pipeline spill", () => {
  test("spools a stream once its in-memory bytes reach the spill threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-pipe-"));
    try {
      const pipeline = new IngestPipeline(dir, { spillPerStream: 64, spillTotal: 128, creditPerStream: 1024, creditTotal: 2048, spoolMaxBytes: 10_000 });
      const chunk = Buffer.alloc(80, 0x61);
      chunk[79] = 0x0a;
      expect(pipeline.enqueueChunk({ session: "s", service: "api", stream: "stdout", pid: 1, readAtMs: 1, bytes: chunk })).toBe(true);
      // The segment is written off the thread; its bytes leave memory once it settles.
      await pipeline.settle();
      expect(pipeline.inFlightBytes()).toBe(0);
      expect(pipeline.spooledBytes()).toBeGreaterThan(0);
      expect(pipeline.paused).toBe(false);
      const lines: string[] = [];
      pipeline.processSlice((line) => lines.push(line.line), 1_000);
      await pipeline.settle();
      pipeline.processSlice((line) => lines.push(line.line), 1_000);
      expect(lines.join("")).toContain("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("proc state", () => {
  test("treats zombies as dead and a running task as alive", () => {
    const stat = "1 (sleep) Z 0 1";
    expect(parseProcStatState(stat)).toBe("Z");
    expect(parseProcPpid("1 (sleep) R 12 1")).toBe(12);
    expect(parseProcPgid("1 (sleep) R 12 9")).toBe(9);
    expect(wedgePath("/repo")).toContain("wedge");
    expect(procStateKind("Z", true)).toBe("zombie");
    expect(procStateKind("R", true)).toBe("alive");
    expect(procStateKind("X", true)).toBe("dead");
  });
});

describe("ring budget", () => {
  test("clamps the automatic ring between 96 and 384 MiB", () => {
    expect(autoRingBytes(1024 * 1024)).toBe(96 * 1024 * 1024);
    expect(autoRingBytes(100 * 1024 * 1024 * 1024)).toBe(384 * 1024 * 1024);
  });
});

describe("session cap", () => {
  test("keeps persisting past the session byte cap by dropping the oldest part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-cap-"));
    try {
      const writer = new SessionLogWriter(dir, 1024, { maxSessionBytes: 16 });
      writer.write("api", "0123456789\n");
      writer.write("api", "abcdefghij\n");
      await writer.flush();
      await writer.close();
      expect(writer.loss).toBe(0);
      expect(writer.degraded).toBeUndefined();
      expect(writer.sessionByteCount()).toBeLessThanOrEqual(16 + 11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chunk ingest", () => {
  test("folds a raw stdout chunk into the ring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-chunk-"));
    try {
      const mgr = new LogManager(10, undefined, undefined, false, dir, "chunk");
      expect(mgr.acceptChunk({
        service: "api",
        stream: "stdout",
        pid: 4,
        readAtMs: Date.parse("2026-09-28T00:00:00.000Z"),
        bytes: Buffer.from("hello-chunk\n"),
      })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const page = mgr.queryPage({});
      expect(page.events.some((event) => JSON.stringify(event).includes("hello-chunk"))).toBe(true);
      await mgr.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stdio handoff", () => {
  test.skipIf(process.platform === "win32")("a service line written through its FIFO reaches the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-stdio-"));
    try {
      const stdio = await new FifoStdio(dir, 1024 * 1024).open("api", { stdout: true, stderr: false });
      expect(stdio).toBeDefined();
      const lines: string[] = [];
      let ended = false;
      const child = spawnSync("/bin/echo", ["stdio-ok"], { stdio: ["ignore", stdio!.stdoutFd!, "ignore"] });
      stdio!.attach(child.pid ?? 0, (stream, bytes, meta) => {
        ended ||= meta?.end === true;
        if (stream === "stdout") {
          lines.push(Buffer.from(bytes).toString("utf8"));
        }
        return true;
      });
      const deadline = Date.now() + 5_000;
      while (!ended && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lines.join("")).toContain("stdio-ok");
      expect(child.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reaper and lag", () => {
  test("an empty service set reaps nothing and lag is recorded", async () => {
    expect(await enableChildSubreaper()).toBe(process.platform === "linux");
    expect(await reapOrphanedChildren([])).toBe(0);
    noteEventLoopLag(4);
    expect(eventLoopLagMs()).toBe(4);
  });
});

describe("fifo drain", () => {
  test.skipIf(process.platform === "win32")("keeps stdout bytes after the writer closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-fifo-"));
    try {
      const fifo = join(dir, "fifo");
      const out = join(dir, "out");
      expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const writer = openSync(fifo, constants.O_RDWR);
      writeSync(writer, Buffer.from("kept\n"));
      closeSync(writer);
      const drained = startDrain({ spoolDir: out, maxBytes: 1024 * 1024, stoppedPath: join(dir, "stopped"), streams: [{ fd: reader, service: "api", stream: "stdout", pid: 1 }] });
      await drained.done;
      closeSync(reader);
      expect(existsSync(join(dir, "stopped"))).toBe(true);
      let text = "";
      await replayDrained(out, () => (_stream, bytes) => {
        text += Buffer.from(bytes).toString("utf8");
        return true;
      });
      expect(text).toBe("kept\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
