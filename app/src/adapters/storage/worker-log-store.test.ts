import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import { Bus, LogReceived } from "../../shared/events.ts";
import { defaultLogParser, logMessage } from "./logs.ts";
import { createDaemonLogStore, WorkerLogStore } from "./worker-log-store.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-wlogs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function config() {
  return {
    max: 100,
    persist: false,
    directory: tmp(),
    sessionID: "w1",
    retentionDays: 0,
    maxSessionLogs: 0,
    extraMarkers: [] as string[],
    extraPatterns: [] as string[],
  };
}

describe("WorkerLogStore", () => {
  test("a raw chunk is folded by the worker and published", async () => {
    const bus = new Bus(16);
    const store = new WorkerLogStore(config(), bus);
    try {
      await store.waitUntilReady();
      expect(store.ingestChunk({
        service: "api",
        stream: "stdout",
        pid: 3,
        readAtMs: Date.parse("2026-09-28T00:00:00.000Z"),
        bytes: Buffer.from("from-chunk\n"),
      })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const page = await store.queryPage({}, { limit: 10 });
      expect(page.events.some((event) => JSON.stringify(event).includes("from-chunk"))).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("an end marker makes the worker emit the stream's last unterminated line", async () => {
    const store = new WorkerLogStore(config(), new Bus(16));
    try {
      await store.waitUntilReady();
      const chunk = { service: "api", stream: "stdout", pid: 9, readAtMs: Date.parse("2026-09-28T00:00:00.000Z") };
      expect(store.ingestChunk({ ...chunk, bytes: Buffer.from("whole\nno newline at exit") })).toBe(true);
      expect(store.ingestChunk({ ...chunk, bytes: new Uint8Array(0), end: true })).toBe(true);
      let messages: string[] = [];
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !messages.includes("no newline at exit")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        messages = (await store.queryPage({}, { limit: 10 })).events.map((event) => logMessage(event));
      }
      expect(messages).toEqual(["whole", "no newline at exit"]);
    } finally {
      await store.close();
    }
  });

  test("pipeline stats settle once persistence has caught up and output has stopped", async () => {
    const dir = tmp();
    const store = new WorkerLogStore({ ...config(), max: 10_000, persist: true, directory: dir, sessionID: "stats", spoolDir: join(dir, "spool") }, new Bus(16));
    const file = join(dir, "session-stats", "api.jsonl");
    const persisted = (): number => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "").length : 0);
    try {
      await store.waitUntilReady(5_000);
      // These commit at once, so the stats on their record batch still count the writer's pending batch.
      for (let n = 1; n <= 200; n += 1) {
        store.append({ timestamp: new Date().toISOString(), service: "api", source: "devctl", level: "INFO", message: `record ${n}`, pid: 0 });
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && persisted() < 200) {
        await Bun.sleep(50);
      }
      expect(persisted()).toBe(200);
      // No further record arrives to refresh the supervisor's copy.
      await Bun.sleep(600);
      expect(store.pipelineStats()?.spooledBytes ?? 0).toBe(0);
      expect(store.pipelineStats()?.inFlightBytes ?? 0).toBe(0);
      expect(store.ingestPaused()).toBe(false);
    } finally {
      await store.close();
    }
  }, 20_000);

  test("readers are released once a flood that paused them has been taken", async () => {
    const dir = tmp();
    // A one-byte spool budget: nothing can spill, so the pipeline refuses chunks once its memory window is full.
    const store = new WorkerLogStore({ ...config(), max: 1_000, directory: dir, sessionID: "pause", spoolDir: join(dir, "spool"), maxSpoolBytes: 1 }, new Bus(16));
    try {
      await store.waitUntilReady(5_000);
      const chunk = Buffer.from(`${"x".repeat(200)}\n`.repeat(1_200));
      let sawPaused = false;
      for (let sent = 0; sent < 200; ) {
        sawPaused ||= store.ingestPaused();
        if (store.ingestChunk({ service: "api", stream: "stdout", pid: 1, readAtMs: Date.now(), bytes: chunk })) {
          sent += 1;
        } else {
          await Bun.sleep(1);
        }
      }
      expect(sawPaused).toBe(true);
      // Output has stopped. Whatever the last ack said, the pause must clear on
      // its own, and the last line's fold closes on its idle timer.
      const lines = 200 * 1_200;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (store.ingestPaused() || store.snapshot().seen < lines)) {
        await Bun.sleep(20);
      }
      expect(store.ingestPaused()).toBe(false);
      expect(store.snapshot().seen).toBe(lines);
      await Bun.sleep(600);
      expect(store.pipelineStats()?.inFlightBytes ?? 0).toBe(0);
    } finally {
      await store.close();
    }
  }, 60_000);

  test("append is visible to queryPage and publishes LogReceived", async () => {
    const bus = new Bus(16);
    const received: string[] = [];
    bus.subscribe((event) => {
      if (event.type === LogReceived) {
        received.push(logMessage(event.payload?.event as Parameters<typeof logMessage>[0]));
      }
    });
    const store = new WorkerLogStore(config(), bus);
    try {
      await store.waitUntilReady();
      store.setParsers([defaultLogParser()]);
      store.append({
        timestamp: "2026-08-30T00:00:00.000Z",
        service: "api",
        source: "stdout",
        level: "",
        message: '{"level":30,"msg":"listening"}',
        pid: 1,
      });
      const page = await store.queryPage({}, { limit: 10 });
      expect(page.events).toHaveLength(1);
      expect(logMessage(page.events[0]!)).toBe("listening");
      expect(page.events[0]?.severityText).toBe("INFO");
      expect(store.snapshot().total).toBe(1);
      expect(store.snapshot().seen).toBe(1);
      expect(received).toContain("listening");
    } finally {
      await store.close();
    }
  });

  test("process stdout folds; proxy does not", async () => {
    const store = new WorkerLogStore(config());
    try {
      await store.waitUntilReady();
      store.append({
        timestamp: "2026-09-19T00:00:00.000Z",
        service: "api",
        source: "stdout",
        level: "",
        message: "INFO GET /api/health",
        pid: 1,
      });
      store.append({
        timestamp: "2026-09-19T00:00:00.010Z",
        service: "api",
        source: "stdout",
        level: "",
        message: "             200",
        pid: 1,
      });
      store.append({
        timestamp: "2026-09-19T00:00:00.020Z",
        service: "edge",
        source: "proxy",
        level: "",
        message: "INFO GET /api/health",
        pid: 0,
      });
      store.append({
        timestamp: "2026-09-19T00:00:00.030Z",
        service: "edge",
        source: "proxy",
        level: "",
        message: "             200",
        pid: 0,
      });
      const page = await store.queryPage({}, { limit: 10 });
      const bodies = page.events.map((event) => logMessage(event));
      expect(bodies).toContain("INFO GET /api/health\n             200");
      expect(bodies.filter((body) => body === "INFO GET /api/health")).toEqual(["INFO GET /api/health"]);
      expect(bodies.filter((body) => body.trim() === "200")).toEqual(["             200"]);
    } finally {
      await store.close();
    }
  });

  test("wraps the ring past max and keeps ingesting", async () => {
    const store = new WorkerLogStore({ ...config(), max: 10 });
    try {
      await store.waitUntilReady();
      for (let i = 0; i < 25; i += 1) {
        store.append({
          timestamp: `2026-08-30T00:00:${String(i).padStart(2, "0")}.000Z`,
          service: "api",
          source: "stdout",
          level: "INFO",
          message: `line ${i}`,
          pid: 1,
        });
      }
      const page = await store.queryPage({}, { limit: 20 });
      expect(page.events).toHaveLength(10);
      expect(logMessage(page.events[0]!)).toBe("line 15");
      expect(logMessage(page.events[9]!)).toBe("line 24");
      expect(store.snapshot().total).toBe(10);
      expect(store.snapshot().seen).toBe(25);
    } finally {
      await store.close();
    }
  });

  test("query fails fast after close", async () => {
    const store = new WorkerLogStore(config());
    await store.waitUntilReady();
    await store.close();
    const started = Date.now();
    await expect(store.queryPage({}, { limit: 1 })).rejects.toThrow(/not running/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("waitUntilReady fails when the worker never posts ready", async () => {
    // This script exits at once, which is noticed before the timeout.
    const store = new WorkerLogStore(config(), undefined, {
      script: new URL("./log-worker-protocol.ts", import.meta.url),
    });
    const started = Date.now();
    await expect(store.waitUntilReady(150)).rejects.toThrow(/timed out|not running|failed|exited/);
    expect(Date.now() - started).toBeLessThan(1000);
    await store.close();
  });
});

describe("createDaemonLogStore", () => {
  test("the worker takes its process's stamp from the daemon instead of reading it again", async () => {
    // Reading it spawns `ps` on macOS and PowerShell on Windows, and the worker has a deadline to start by.
    const directory = tmp();
    const selfStamp = { bootId: "boot-read-on-the-main-thread", lstart: "start-read-on-the-main-thread" };
    const { logs, usingWorker } = await createDaemonLogStore({ ...config(), persist: true, directory, sessionID: "stamped", selfStamp }, new Bus(16), new Detector([], []));
    try {
      expect(usingWorker).toBe(true);
      const manifest = JSON.parse(readFileSync(join(directory, "session-stamped", "manifest.json"), "utf8")) as { owner: Record<string, unknown> };
      expect(manifest.owner).toEqual({ pid: process.pid, ...selfStamp });
    } finally {
      await logs.close();
    }
  });

  test("starts the log worker even when the process is a compiled binary", async () => {
    const bus = new Bus(16);
    const detector = new Detector([], []);
    const { logs, usingWorker } = await createDaemonLogStore(config(), bus, detector, { standalone: true });
    expect(usingWorker).toBe(true);
    try {
      logs.append({
        timestamp: "2026-08-30T00:00:00.000Z",
        service: "api",
        source: "stdout",
        level: "INFO",
        message: "hello",
        pid: 1,
      });
      const page = await logs.queryPage({}, { limit: 10 });
      expect(logMessage(page.events[0]!)).toBe("hello");
    } finally {
      await logs.close();
    }
  });

  test("falls back to in-process logging when the worker never becomes ready, and says why", async () => {
    const bus = new Bus(16);
    const detector = new Detector([], []);
    const started = performance.now();
    const { logs, usingWorker, reason } = await createDaemonLogStore(config(), bus, detector, {
      script: new URL("./no-such-worker.ts", import.meta.url),
      initTimeoutMs: 4_000,
    });
    expect(usingWorker).toBe(false);
    // A worker that cannot load is given up on through its error, not by waiting out the time allowed.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(reason).toBeString();
    expect(reason).not.toBe("log worker init timed out");
    // A worker that loads, stays alive, and never answers its init.
    const hangs = new URL(URL.createObjectURL(new Blob(["setInterval(() => undefined, 60_000);"], { type: "application/javascript" })));
    const hung = await createDaemonLogStore(config(), bus, detector, { script: hangs, initTimeoutMs: 150 });
    expect(hung.usingWorker).toBe(false);
    expect(hung.reason).toBe("log worker init timed out");
    await hung.logs.close();
    try {
      logs.append({
        timestamp: "2026-08-30T00:00:00.000Z",
        service: "api",
        source: "stdout",
        level: "INFO",
        message: "fallback",
        pid: 1,
      });
      const page = await logs.queryPage({}, { limit: 10 });
      expect(logMessage(page.events[0]!)).toBe("fallback");
    } finally {
      await logs.close();
    }
  });

  test("says whether a worker holds the ring, for status", async () => {
    const bus = new Bus(16);
    const detector = new Detector([], []);
    const worker = await createDaemonLogStore(config(), bus, detector);
    const fallback = await createDaemonLogStore(config(), bus, detector, {
      script: new URL("./no-such-worker.ts", import.meta.url),
      initTimeoutMs: 200,
    });
    try {
      expect(worker.logs.usesWorker?.()).toBe(true);
      expect(fallback.logs.usesWorker?.() ?? false).toBe(false);
    } finally {
      await worker.logs.close();
      await fallback.logs.close();
    }
    expect(worker.logs.usesWorker?.()).toBe(false);
  });
});
