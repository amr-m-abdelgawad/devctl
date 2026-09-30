import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { LogBatchPayload } from "../../domain/logs/batch.ts";
import { Bus, LogBatch, LogReceived } from "../../shared/events.ts";
import { logMessage, type LogRecord } from "./logs.ts";
import { WorkerLogStore, type WorkerLogConfig } from "./worker-log-store.ts";

const dirs: string[] = [];

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-lanes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(overrides: Partial<WorkerLogConfig> = {}): WorkerLogConfig {
  const dir = tmp();
  return {
    max: 10_000,
    persist: false,
    directory: dir,
    sessionID: "lanes",
    retentionDays: 0,
    maxSessionLogs: 0,
    extraMarkers: [],
    extraPatterns: [],
    spoolDir: join(dir, "spool"),
    ...overrides,
  };
}

type Traffic = { received: string[]; batches: LogBatchPayload[]; fromWorker: Record<string, number> };

function watch(store: WorkerLogStore, bus: Bus): Traffic {
  const traffic: Traffic = { received: [], batches: [], fromWorker: {} };
  bus.subscribe((event) => {
    if (event.type === LogReceived) {
      traffic.received.push(logMessage(event.payload?.event as LogRecord));
    } else if (event.type === LogBatch) {
      traffic.batches.push(event.payload as unknown as LogBatchPayload);
    }
  });
  const worker = (store as unknown as { worker: Worker }).worker;
  worker.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
    traffic.fromWorker[event.data.type] = (traffic.fromWorker[event.data.type] ?? 0) + 1;
  });
  return traffic;
}

// Holds structured-append batches on the way to the worker, as a worker that
// is slow to take them would, and counts every message posted to it.
function holdAppends(store: WorkerLogStore): { held: unknown[]; counts: Record<string, number>; release: () => void } {
  const worker = (store as unknown as { worker: Worker }).worker;
  const post = worker.postMessage.bind(worker);
  const held: unknown[] = [];
  const counts: Record<string, number> = {};
  let holding = true;
  (worker as unknown as { postMessage: (message: { type: string }) => void }).postMessage = (message) => {
    counts[message.type] = (counts[message.type] ?? 0) + 1;
    if (holding && message.type === "appendBatch") {
      held.push(message);
      return;
    }
    post(message);
  };
  return {
    held,
    counts,
    release: () => {
      holding = false;
      for (const message of held.splice(0)) {
        post(message);
      }
    },
  };
}

function proxyLine(message: string) {
  return { timestamp: new Date().toISOString(), service: "proxy", source: "proxy", level: "INFO", message, pid: 0 };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(predicate()).toBe(true);
}

describe("worker record batches", () => {
  test("records come back in a few batches, and each is still published once", async () => {
    const bus = new Bus(16);
    const store = new WorkerLogStore(config(), bus);
    try {
      await store.waitUntilReady();
      const traffic = watch(store, bus);
      const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
      for (let offset = 0; offset < lines.length; offset += 500) {
        const text = `${lines.slice(offset, offset + 500).join("\n")}\n`;
        expect(store.ingestChunk({ service: "api", stream: "stdout", pid: 1, readAtMs: Date.now(), bytes: Buffer.from(text) })).toBe(true);
      }
      await until(() => traffic.received.length === lines.length);
      await store.flush();
      expect(traffic.received).toEqual(lines);
      // One message per record before; now one per batch.
      expect(traffic.fromWorker.appended).toBeLessThan(40);
      // The batch path keeps the newest records and counts the rest as skipped.
      const accounted = traffic.batches.reduce((sum, batch) => sum + batch.newest.length + batch.skipped, 0);
      expect(accounted).toBe(lines.length);
      expect(traffic.batches.at(-1)?.lastSeq).toBe(store.snapshot().seen);
    } finally {
      await store.close();
    }
  });

  test("a lone line is published without waiting out a batch interval", async () => {
    const bus = new Bus(16);
    const store = new WorkerLogStore(config(), bus);
    try {
      await store.waitUntilReady();
      const traffic = watch(store, bus);
      // Leave a quiet gap so the next batch may go at once.
      await Bun.sleep(80);
      const readAt = Date.now();
      store.append({ timestamp: new Date().toISOString(), service: "proxy", source: "proxy", level: "INFO", message: "GET /health", pid: 0 });
      await until(() => traffic.batches.length > 0);
      expect(Date.now() - readAt).toBeLessThan(200);
      expect(traffic.received).toEqual(["GET /health"]);
    } finally {
      await store.close();
    }
  });
});

describe("structured append lane", () => {
  test("appends go in a few batches, each keeping the time it was appended", async () => {
    const bus = new Bus(16);
    const store = new WorkerLogStore(config(), bus);
    try {
      await store.waitUntilReady();
      const traffic = watch(store, bus);
      const gate = holdAppends(store);
      const hook = { service: "api:pre_start", source: "stdout", stream: "stdout", level: "", pid: 0 };
      // A hook printed a traceback's first line, then paused past the fold wait.
      store.append({ ...hook, timestamp: new Date().toISOString(), message: "Traceback (most recent call last):" });
      await Bun.sleep(150);
      store.append({ ...hook, timestamp: new Date().toISOString(), message: "  File \"setup.py\", line 3, in <module>" });
      for (let i = 0; i < 3_000; i += 1) {
        store.append(proxyLine(`GET /item/${i}`));
      }
      await Bun.sleep(20);
      // Both hook lines reach the worker together, read 150 ms apart.
      gate.release();
      await until(() => traffic.received.length === 3_002);
      expect(gate.counts.appendBatch).toBeLessThan(10);
      expect(traffic.received.filter((message) => !message.startsWith("GET "))).toEqual([
        "Traceback (most recent call last):",
        "  File \"setup.py\", line 3, in <module>",
      ]);
    } finally {
      await store.close();
    }
  });

  test("a worker failure replays exactly the appends it never acked", async () => {
    const bus = new Bus(16);
    const store = new WorkerLogStore(config(), bus);
    try {
      await store.waitUntilReady();
      const traffic = watch(store, bus);
      for (const message of ["acked 1", "acked 2", "acked 3"]) {
        store.append(proxyLine(message));
      }
      // Records from chunks are acked by chunk, never by append.
      expect(store.ingestChunk({ service: "api", stream: "stdout", pid: 1, readAtMs: Date.now(), bytes: Buffer.from("chunk line 1\nchunk line 2\n") })).toBe(true);
      await until(() => traffic.received.length === 5);
      const gate = holdAppends(store);
      store.append(proxyLine("unacked 1"));
      store.append(proxyLine("unacked 2"));
      await until(() => gate.held.length === 1);
      (store as unknown as { worker: Worker }).worker.dispatchEvent(new ErrorEvent("error", { message: "log worker crashed" }));
      const page = await store.queryPage({}, { limit: 100 });
      expect(page.events.map((event) => logMessage(event))).toEqual(["unacked 1", "unacked 2"]);
      expect(store.usesWorker()).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("a flood backs the lane up, and producers that can wait are told to", async () => {
    const store = new WorkerLogStore(config());
    try {
      await store.waitUntilReady();
      const gate = holdAppends(store);
      const body = "o".repeat(64 * 1024);
      let appended = 0;
      while (!store.ingestPaused() && appended < 10_000) {
        store.append({ service: "otlp", source: "otlp", level: "INFO", message: body, body, pid: 0 });
        appended += 1;
      }
      expect(store.ingestPaused()).toBe(true);
      // Paused at 16 MiB held, well short of a flood that would not stop.
      expect(appended).toBeLessThan(400);
      gate.release();
      await until(() => !store.ingestPaused());
      await until(() => store.snapshot().seen === appended);
      expect(gate.counts.setUpstreamPaused).toBeGreaterThanOrEqual(2);
    } finally {
      await store.close();
    }
  });
});
