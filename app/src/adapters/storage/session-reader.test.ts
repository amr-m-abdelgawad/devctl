import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import { logMessage, logRecord, type LogRecord } from "../../domain/logs/logs.ts";
import { encodeLogCursor } from "../../domain/logs/pagination.ts";
import { pageSource } from "./log-page.ts";
import { LogManager, type LogManagerOptions } from "./logs.ts";
import { MatchCache } from "./match-cache.ts";
import { readBudget, SessionReader } from "./session-reader.ts";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "devctl-reader-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PAD = "p".repeat(1_000);

async function filled(count: number, options: LogManagerOptions, services = ["api"], session = "window"): Promise<LogManager> {
  const mgr = new LogManager(count, undefined, new Detector([], []), true, tmp(), session, 0, 0, options);
  for (let i = 1; i <= count; i += 1) {
    mgr.append({
      timestamp: new Date(Date.UTC(2026, 8, 1) + i).toISOString(),
      service: services[i % services.length]!,
      source: "stdout",
      level: i % 50 === 0 ? "ERROR" : "INFO",
      message: `line ${i} ${PAD}`,
      pid: 1,
    });
    if (i % 1_000 === 0) {
      await mgr.flush();
    }
  }
  await mgr.flush();
  return mgr;
}

function lineNumbers(events: readonly LogRecord[]): number[] {
  return events.map((event) => Number(logMessage(event).split(" ")[1]));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function cursorAt(session: string, seq: number): string {
  return encodeLogCursor({ session, seq });
}

function writeLines(dir: string, name: string, records: readonly LogRecord[]): void {
  writeFileSync(join(dir, name), records.map((record) => `${JSON.stringify(record)}\n`).join(""), { flag: "a" });
}

describe("reading the evicted part of the window", () => {
  test("a page below a byte-evicted ring reads records from the session's earliest part file", async () => {
    // 5,000 records of ~2 KiB in parts of 2 MiB. The ring keeps a few dozen and
    // a query may read 1 MiB, so a tail scan within that budget never reached
    // part 0, which alone holds records 101..200.
    const mgr = await filled(5_000, { maxMemoryBytes: 64 * 1024, maxSessionBytes: 16 * 1024 * 1024, historyScanBytes: 1024 * 1024 });
    const parts = readdirSync(mgr.sessionDir()).filter((name) => name.endsWith(".jsonl")).sort();
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]).toBe("api.jsonl");
    const secondPart = readFileSync(join(mgr.sessionDir(), "api~1.jsonl"), "utf8");
    expect(JSON.parse(secondPart.slice(0, secondPart.indexOf("\n"))).seq).toBeGreaterThan(200);
    expect(mgr.snapshot().total).toBeLessThan(100);
    const page = mgr.queryPage({}, { cursor: cursorAt("window", 201), direction: "backward", limit: 100 });
    expect(lineNumbers(page.events)).toEqual(range(101, 200));
    expect(page.hasPrev).toBe(true);
    expect(page.hasNext).toBe(true);
    const sessionBytes = parts.reduce((total, name) => total + statSync(join(mgr.sessionDir(), name)).size, 0);
    expect(mgr.evictedBytesRead()).toBeLessThan(sessionBytes / 4);
    await mgr.close();
  });

  test("a forward poll at the head never reads the session files", async () => {
    const mgr = await filled(3_000, { maxMemoryBytes: 64 * 1024 });
    const newest = mgr.queryPage({}, { limit: 20 });
    expect(lineNumbers(newest.events)).toEqual(range(2_981, 3_000));
    const before = mgr.evictedBytesRead();
    expect(mgr.queryPage({}, { cursor: newest.nextCursor, direction: "forward" }).events).toEqual([]);
    mgr.append({ timestamp: new Date().toISOString(), service: "api", source: "stdout", level: "INFO", message: "line 3001 new", pid: 1 });
    const poll = mgr.queryPage({}, { cursor: newest.nextCursor, direction: "forward" });
    expect(lineNumbers(poll.events)).toEqual([3_001]);
    expect(poll.hasPrev).toBe(true);
    expect(mgr.queryPage({ level: "ERROR" }, { cursor: poll.nextCursor, direction: "forward" }).events).toEqual([]);
    expect(mgr.evictedBytesRead()).toBe(before);
    await mgr.close();
  });

  test("a gap-filler page of evicted records comes back whole", async () => {
    // The TUI pages a skipped range in with a backward cursor one past its end
    // and clears its gaps when a page comes back short.
    const mgr = await filled(4_000, { maxMemoryBytes: 64 * 1024 }, ["api", "worker"]);
    const page = mgr.queryPage({}, { cursor: cursorAt("window", 2_501), direction: "backward", limit: 500 });
    expect(lineNumbers(page.events)).toEqual(range(2_001, 2_500));
    await mgr.close();
  });

  test("paging forward from the oldest page walks the evicted part into the ring once each", async () => {
    const mgr = await filled(2_000, { maxMemoryBytes: 64 * 1024 }, ["api", "worker", "auth"]);
    let page = mgr.queryPage({}, { cursor: cursorAt("window", 0), direction: "forward", limit: 300 });
    const seen = lineNumbers(page.events);
    while (page.hasNext) {
      page = mgr.queryPage({}, { cursor: page.nextCursor, direction: "forward", limit: 300 });
      seen.push(...lineNumbers(page.events));
    }
    expect(seen).toEqual(range(1, 2_000));
    const errors = mgr.queryPage({ level: "ERROR", services: ["worker"] }, { limit: 1_000 });
    expect(lineNumbers(errors.events)).toEqual(range(1, 2_000).filter((i) => i % 50 === 0 && i % 3 === 1));
    await mgr.close();
  });

  test("a budget cut short still makes progress page by page", async () => {
    // Each query may read 512 KiB of a 6 MiB evicted part.
    const mgr = await filled(3_000, { maxMemoryBytes: 64 * 1024, historyScanBytes: 512 * 1024 });
    let page = mgr.queryPage({ level: "ERROR" }, { limit: 1_000 });
    const seen = lineNumbers(page.events);
    let calls = 1;
    while (page.hasPrev && calls < 500) {
      page = mgr.queryPage({ level: "ERROR" }, { cursor: page.prevCursor, direction: "backward", limit: 1_000 });
      seen.unshift(...lineNumbers(page.events));
      calls += 1;
    }
    expect(calls).toBeGreaterThan(1);
    expect(seen).toEqual(range(1, 3_000).filter((i) => i % 50 === 0));
    await mgr.close();
  });

  test("files an earlier store left in the session directory are not part of this window", async () => {
    const root = tmp();
    const dir = join(root, "session-reused");
    mkdirSync(dir, { recursive: true });
    writeLines(dir, "api.jsonl", range(1, 50).map((seq) => logRecord({ seq, service: "api", message: `stale ${seq}` })));
    const mgr = new LogManager(200, undefined, new Detector([], []), true, root, "reused", 0, 0, { maxMemoryBytes: 16 * 1024 });
    for (let i = 1; i <= 200; i += 1) {
      mgr.append({ timestamp: new Date().toISOString(), service: "api", source: "stdout", level: "INFO", message: `fresh ${i} ${PAD}`, pid: 1 });
    }
    await mgr.flush();
    const page = mgr.queryPage({}, { cursor: cursorAt("reused", 51), direction: "backward", limit: 50 });
    expect(page.events.map((event) => logMessage(event).split(" ")[0])).toEqual(Array.from({ length: 50 }, () => "fresh"));
    await mgr.close();
  });
});

describe("remembering a selective filter's matches", () => {
  const errors = (upTo: number): number[] => range(1, upTo).filter((i) => i % 50 === 0);

  test("a repeated poll reads only the matched lines, and a later one only what was evicted since", async () => {
    const mgr = await filled(3_000, { maxMemoryBytes: 64 * 1024 });
    const first = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
    expect(lineNumbers(first.events)).toEqual(errors(3_000));
    const scanned = mgr.evictedBytesRead();
    const again = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
    expect(again.events).toEqual(first.events);
    const repeat = mgr.evictedBytesRead() - scanned;
    expect(repeat).toBeLessThan(scanned / 10);
    for (let i = 3_001; i <= 3_300; i += 1) {
      mgr.append({ timestamp: new Date().toISOString(), service: "api", source: "stdout", level: i % 50 === 0 ? "ERROR" : "INFO", message: `line ${i} ${PAD}`, pid: 1 });
    }
    await mgr.flush();
    const before = mgr.evictedBytesRead();
    const later = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
    expect(lineNumbers(later.events)).toEqual(errors(3_300).filter((i) => i > 300));
    expect(mgr.evictedBytesRead() - before).toBeLessThan(scanned / 4);
    await mgr.close();
  });

  test("polls the budget cuts short fill the page in over successive calls", async () => {
    // 512 KiB a query over a 6 MiB evicted part. Each poll scans on from
    // where the cache ends; spans sized by the seek and look-ahead each one
    // pays (rather than by the lines they cover) shrank until a poll moved
    // only a few dozen seqs, and 100 polls did not reach the window's start.
    const mgr = await filled(3_000, { maxMemoryBytes: 64 * 1024, historyScanBytes: 512 * 1024 });
    let page = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
    let polls = 1;
    while (page.hasPrev && polls < 100) {
      page = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
      polls += 1;
    }
    expect(polls).toBeGreaterThan(1);
    expect(polls).toBeLessThan(60);
    expect(lineNumbers(page.events)).toEqual(errors(3_000));
    await mgr.close();
  });
});

describe("match cache", () => {
  const at = (seq: number) => ({ seq, part: "api.jsonl", offset: seq * 10, length: 9 });

  test("a run that touches the cached range is folded in, its own matches winning", () => {
    const cache = new MatchCache();
    cache.remember("k", { lo: 10, hi: 20, matches: [at(12), at(15), at(18)] });
    cache.remember("k", { lo: 16, hi: 30, matches: [at(17), at(25)] });
    expect(cache.get("k", 1)).toEqual({ lo: 10, hi: 30, matches: [at(12), at(15), at(17), at(25)] });
    cache.remember("k", { lo: 2, hi: 10, matches: [at(3)] });
    expect(cache.get("k", 1)?.matches.map((row) => row.seq)).toEqual([3, 12, 15, 17, 25]);
    expect(cache.get("k", 13)).toEqual({ lo: 13, hi: 30, matches: [at(15), at(17), at(25)] });
    expect(cache.get("k", 30)).toBeUndefined();
  });

  test("a run apart from the cached range replaces it, and old queries age out", () => {
    const cache = new MatchCache();
    cache.remember("k", { lo: 10, hi: 20, matches: [at(12)] });
    cache.remember("k", { lo: 40, hi: 50, matches: [at(45)] });
    expect(cache.get("k", 1)).toEqual({ lo: 40, hi: 50, matches: [at(45)] });
    for (let key = 0; key < 9; key += 1) {
      cache.remember(`q${key}`, { lo: 1, hi: 2, matches: [] });
    }
    expect(cache.get("k", 1)).toBeUndefined();
    expect(cache.get("q8", 1)).toBeDefined();
  });
});

describe("session reader", () => {
  test("the last copy of a replaced record wins", () => {
    const dir = tmp();
    const records = range(1, 400).map((seq) => logRecord({ seq, service: "api", message: `line ${seq} ${PAD}` }));
    writeLines(dir, "api.jsonl", records.slice(0, 300));
    writeLines(dir, "api.jsonl", [{ ...records[299]!, attributes: { "http.request_id": "late" } }]);
    writeLines(dir, "api.jsonl", records.slice(300));
    const reader = new SessionReader(dir);
    const source = reader.source({ matches: () => true }, 1, 401, readBudget(64 * 1024 * 1024, 10_000));
    const page = pageSource(source, { cursor: 302, direction: "backward", limit: 3 });
    expect(page.events.map((event) => event.seq)).toEqual([299, 300, 301]);
    expect(page.events[1]?.attributes["http.request_id"]).toBe("late");
  });

  test("seeks through a large part with probes instead of reading it whole", () => {
    const dir = tmp();
    const records = range(1, 20_000).map((seq) => logRecord({ seq, service: "api", message: `line ${seq} ${PAD}` }));
    writeLines(dir, "api.jsonl", records);
    const size = statSync(join(dir, "api.jsonl")).size;
    const reader = new SessionReader(dir);
    const first = pageSource(reader.source({ matches: () => true }, 1, 20_001, readBudget(64 * 1024 * 1024, 10_000)), { cursor: 10_001, direction: "backward", limit: 50 });
    expect(first.events.map((event) => event.seq)).toEqual(range(9_951, 10_000));
    const cold = reader.bytesRead;
    expect(cold).toBeLessThan(size / 10);
    // The index built by the first page leaves only the page's own stretch to read.
    pageSource(reader.source({ matches: () => true }, 1, 20_001, readBudget(64 * 1024 * 1024, 10_000)), { cursor: 10_001, direction: "backward", limit: 50 });
    expect(reader.bytesRead - cold).toBeLessThan(cold);
    expect(reader.bytesRead - cold).toBeLessThan(512 * 1024);
    expect(reader.lastSeq(readBudget(1024 * 1024, 1_000))).toBe(20_000);
  });
});
