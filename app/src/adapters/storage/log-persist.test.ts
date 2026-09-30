import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readSelfStamp } from "../process/liveness.ts";
import { OrderedSpool } from "./ingest/spool.ts";
import { sessionSpoolPrefix } from "./ingest/pipeline.ts";
import { SessionLogWriter } from "./log-persist.ts";
import { LogManager } from "./logs.ts";
import { loadSessionEvents } from "./session-files.ts";
import { pruneSessions } from "./session-prune.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devctl-persist-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function serviceFiles(dir: string, service: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.startsWith(service) && name.endsWith(".jsonl"));
}

function readService(dir: string, service: string): string {
  return serviceFiles(dir, service).map((name) => readFileSync(join(dir, name), "utf8")).join("");
}

function serviceBytes(dir: string, service: string): number {
  return serviceFiles(dir, service).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}

describe("session log writer", () => {
  test("a full session rotates and keeps the newest lines instead of pausing", async () => {
    const dir = tempDir();
    const writer = new SessionLogWriter(dir, 1 << 20, { maxSessionBytes: 256 });
    for (let i = 0; i < 40; i += 1) {
      writer.write("api", `{"n":${i},"pad":"xxxxxxxxxxxxxxxx"}\n`);
    }
    await writer.flush();
    expect(writer.degraded).toBeUndefined();
    expect(writer.loss).toBe(0);
    expect(readService(dir, "api")).toContain("\"n\":39");
    // The cap may be exceeded by at most the line that crossed it.
    expect(serviceBytes(dir, "api")).toBeLessThanOrEqual(256 + 64);
    await writer.close();
  });

  test("persistence failures never pause ingest", async () => {
    const root = tempDir();
    const mgr = new LogManager(100, undefined, undefined, true, root, "cap", 0, 0, { maxSessionBytes: 4096 });
    for (let i = 0; i < 60; i += 1) {
      mgr.append({ timestamp: new Date().toISOString(), service: "api", source: "devctl", level: "INFO", message: `record-${i}`, pid: 0 });
    }
    await mgr.flush();
    expect(mgr.ingestPaused()).toBe(false);
    await mgr.close();
  });
});

describe("session log writer recovery", () => {
  test("a low disk drops lines from persistence and recovers on its own", async () => {
    const dir = tempDir();
    let clock = 1_000_000;
    let reserve = false;
    const writer = new SessionLogWriter(dir, 1 << 20, { hasDiskReserve: () => reserve, now: () => clock });
    writer.write("api", "{\"n\":1}\n");
    expect(writer.degraded).toBe("disk-low");
    expect(writer.loss).toBe(1);
    reserve = true;
    clock += 1_000;
    writer.write("api", "{\"n\":2}\n");
    expect(writer.loss).toBe(2);
    clock += 5_000;
    writer.write("api", "{\"n\":3}\n");
    await writer.flush();
    expect(writer.degraded).toBeUndefined();
    expect(readService(dir, "api")).toBe("{\"n\":3}\n");
    await writer.close();
  });

  test("a burst of 30,000 records persists every seq exactly once", async () => {
    const root = tempDir();
    const mgr = new LogManager(50_000, undefined, undefined, true, root, "burst", 0, 0, { maxSessionBytes: 64 << 20 });
    for (let i = 0; i < 30_000; i += 1) {
      mgr.append({ timestamp: new Date().toISOString(), service: i % 3 === 0 ? "api" : "web", source: "devctl", level: "INFO", message: `record-${i}`, pid: 0 });
    }
    await mgr.close();
    const seqs = loadSessionEvents("session-burst", root).map((event) => event.seq);
    expect(seqs).toHaveLength(30_000);
    expect(seqs[0]).toBe(1);
    expect(seqs[seqs.length - 1]).toBe(30_000);
  });
});

describe("session retention", () => {
  function makeSession(root: string, name: string, manifest: Record<string, unknown>, bytes: number, mtimeMs: number): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "FORMAT"), "jsonl\n");
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    writeFileSync(join(dir, "api.jsonl"), "x".repeat(bytes));
    const at = new Date(mtimeMs);
    utimesSync(dir, at, at);
    return dir;
  }

  test("the byte pruner never deletes another daemon's live session", () => {
    const root = tempDir();
    const now = Date.now();
    const live = makeSession(root, "session-2026-09-01T00-00-00Z-aaaaaa", { repo: "other", owner: { pid: process.pid, ...readSelfStamp() } }, 8 * 1024, now - 3_000_000);
    const closed = makeSession(root, "session-2026-09-02T00-00-00Z-bbbbbb", { repo: "other", closedAt: "2026-09-02T01:00:00.000Z" }, 8 * 1024, now - 2_000_000);
    const mine = makeSession(root, "session-2026-09-03T00-00-00Z-cccccc", { repo: "mine" }, 1024, now - 1_000_000);
    pruneSessions(root, 0, 0, "mine", { maxTotalBytes: 10 * 1024, liveDir: mine });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(closed)).toBe(false);
  });

  test("a store that takes over a session leaves that session's own spool to its pipeline", async () => {
    const root = tempDir();
    const logs = join(root, "logs");
    const spoolDir = join(root, "log-spool");
    const own = join(spoolDir, `${sessionSpoolPrefix("same")}api_stdout_7`);
    const spool = new OrderedSpool(own, 1 << 20);
    spool.append({ session: "same", service: "api", stream: "stdout", pid: 7 }, [{ readAtMs: Date.now(), bytes: Buffer.from("still-live\n") }]);
    const mgr = new LogManager(100, undefined, undefined, true, logs, "same", 0, 0, { spoolDir });
    await mgr.replayDone();
    expect(existsSync(own)).toBe(true);
    await mgr.close();
  });

  test.skipIf(process.platform !== "linux")("a session owned from another PID namespace counts as live while it is written", () => {
    const root = tempDir();
    const now = Date.now();
    const elsewhere = { pid: 1, pidNs: "pid:[1]", startTicks: "1" };
    const writing = makeSession(root, "session-2026-09-01T00-00-00Z-gggggg", { repo: "other", owner: elsewhere }, 8 * 1024, now - 3_000_000);
    const abandoned = makeSession(root, "session-2026-09-02T00-00-00Z-hhhhhh", { repo: "other", owner: elsewhere }, 8 * 1024, now - 2_000_000);
    const old = new Date(now - 60 * 60_000);
    for (const name of readdirSync(abandoned)) {
      utimesSync(join(abandoned, name), old, old);
    }
    const mine = makeSession(root, "session-2026-09-03T00-00-00Z-iiiiii", { repo: "mine" }, 1024, now);
    pruneSessions(root, 0, 0, "mine", { maxTotalBytes: 10 * 1024, liveDir: mine });
    expect(existsSync(writing)).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
  });

  test("another repo's closed session follows the retention it was written with", () => {
    const root = tempDir();
    const day = 86_400_000;
    const now = Date.now();
    const expired = makeSession(root, "session-2026-09-01T00-00-00Z-dddddd", { repo: "other", retentionDays: 1, closedAt: "2026-09-01T01:00:00.000Z" }, 64, now - 3 * day);
    const keptForever = makeSession(root, "session-2026-09-02T00-00-00Z-eeeeee", { repo: "other", retentionDays: 0, closedAt: "2026-09-02T01:00:00.000Z" }, 64, now - 30 * day);
    const mine = makeSession(root, "session-2026-09-03T00-00-00Z-ffffff", { repo: "mine" }, 64, now);
    pruneSessions(root, 0, 0, "mine", { liveDir: mine });
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(keptForever)).toBe(true);
  });

  test("a crashed daemon's spool is replayed into its own session and removed", async () => {
    const root = tempDir();
    const logs = join(root, "logs");
    const spoolDir = join(root, "log-spool");
    const deadStream = join(spoolDir, "api_stdout_4242");
    const spool = new OrderedSpool(deadStream, 1 << 20);
    expect(spool.append({ session: "dead", service: "api", stream: "stdout", pid: 4242 }, [
      { readAtMs: Date.parse("2026-09-28T10:00:00.000Z"), bytes: Buffer.from("left-behind\n") },
    ])).toBe("ok");
    const mgr = new LogManager(100, undefined, undefined, true, logs, "fresh", 0, 0, { spoolDir });
    await mgr.replayDone();
    await mgr.close();
    expect(readService(join(logs, "session-dead"), "api")).toContain("left-behind");
    expect(existsSync(deadStream)).toBe(false);
  });
});
