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
