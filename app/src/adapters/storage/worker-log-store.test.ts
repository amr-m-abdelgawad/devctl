import { mkdirSync } from "node:fs";
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
      expect(received).toContain("listening");
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

  test("waitUntilReady times out when the worker never posts ready", async () => {
    const store = new WorkerLogStore(config(), undefined, {
      script: new URL("./log-worker-protocol.ts", import.meta.url),
    });
    const started = Date.now();
    await expect(store.waitUntilReady(150)).rejects.toThrow(/timed out|not running|failed/);
    expect(Date.now() - started).toBeLessThan(1000);
    await store.close();
  });
});

describe("createDaemonLogStore", () => {
  test("uses in-process logging for compiled standalone binaries", async () => {
    const bus = new Bus(16);
    const detector = new Detector([], []);
    const { logs, usingWorker } = await createDaemonLogStore(config(), bus, detector, { standalone: true });
    expect(usingWorker).toBe(false);
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

  test("falls back to in-process logging when the worker never becomes ready", async () => {
    const bus = new Bus(16);
    const detector = new Detector([], []);
    const { logs, usingWorker } = await createDaemonLogStore(config(), bus, detector, {
      script: new URL("./no-such-worker.ts", import.meta.url),
      initTimeoutMs: 200,
    });
    expect(usingWorker).toBe(false);
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
});
