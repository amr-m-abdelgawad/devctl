import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import { logMessage, logRecord, REQUEST_ID_ATTR, type LogRecord } from "../../domain/logs/logs.ts";
import { encodeLogCursor } from "../../domain/logs/pagination.ts";
import { pageSource } from "./log-page.ts";
import { LogManager, type LogManagerOptions } from "./logs.ts";
import { MatchCache } from "./match-cache.ts";
import { loadSessionEvents, loadSessionTail } from "./session-files.ts";
import { SessionHistory } from "./session-history.ts";
import { readBudget, SessionReader } from "./session-reader.ts";
import { createDaemonLogStore } from "./worker-log-store.ts";
import { Bus } from "../../shared/events.ts";

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

describe("exporting the window", () => {
  test("an export includes the records the ring has evicted, in order, one per line", async () => {
    // 2,000 records of about 1.3 KiB against a 256 KiB ring: most of the window is only on disk.
    const mgr = await filled(2_000, { maxMemoryBytes: 256 * 1024, maxSessionBytes: 64 * 1024 * 1024 });
    try {
      expect(mgr.snapshot().total).toBeLessThan(500);
      const dest = join(tmp(), "window.jsonl");
      mgr.exportTo(dest, {});
      const lines = readFileSync(dest, "utf8").trimEnd().split("\n");
      const numbers = lines.map((line) => Number((JSON.parse(line) as { body: string }).body.split(" ")[1]));
      expect(numbers).toEqual(range(1, 2_000));

      const errors = join(tmp(), "errors.jsonl");
      mgr.exportTo(errors, { level: "ERROR" });
      expect(readFileSync(errors, "utf8").trimEnd().split("\n")).toHaveLength(40);
    } finally {
      await mgr.close();
    }
  });
});

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
    // This store continues past the earlier one's seqs, and its window holds only its own records.
    const page = mgr.queryPage({}, { limit: 500 });
    expect(page.events.map((event) => logMessage(event).split(" ")[0])).toEqual(Array.from({ length: 200 }, () => "fresh"));
    expect(page.events[0]?.seq).toBe(51);
    const older = mgr.queryPage({}, { cursor: cursorAt("reused", 61), direction: "backward", limit: 50 });
    expect(older.events.map((event) => logMessage(event).split(" ")[0])).toEqual(Array.from({ length: 10 }, () => "fresh"));
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

describe("what disk serves is what the ring held", () => {
  const HOP = "grpc /temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue route=temporal-grpc grpc-status=14";
  const POLLED = "ERROR temporalio_client::retry: gRPC call poll_activity_task_queue retried 41 times";

  // The whole window, oldest first, a page at a time.
  function everything(mgr: LogManager, session: string): LogRecord[] {
    const out: LogRecord[] = [];
    let page = mgr.queryPage({}, { cursor: cursorAt(session, 0), direction: "forward", limit: 400 });
    out.push(...page.events);
    while (page.hasNext) {
      page = mgr.queryPage({}, { cursor: page.nextCursor, direction: "forward", limit: 400 });
      out.push(...page.events);
    }
    return out;
  }

  // A worker line and the proxy hop that tags it afterwards, 10 ms apart in event time.
  function hopPair(mgr: LogManager, atMs: number, requestId: string): void {
    mgr.append({ timestamp: new Date(atMs + 10).toISOString(), service: "proxy", source: "proxy", level: "WARN", message: HOP, pid: 0, request_id: requestId }, atMs + 10);
  }

  function workerLine(mgr: LogManager, atMs: number): void {
    mgr.append({ timestamp: new Date(atMs).toISOString(), service: "worker", source: "stdout", level: "", message: POLLED, pid: 1 }, atMs);
  }

  test("a page read back from disk equals the same seqs read from the ring", async () => {
    const root = tmp();
    // Parts of 512 KiB, so the window spans several per service.
    const mgr = new LogManager(5_000, undefined, new Detector([], []), true, root, "lossless", 0, 0, { maxMemoryBytes: 256 * 1024 * 1024, maxSessionBytes: 4 * 1024 * 1024 });
    const at = Date.now();
    for (let i = 1; i <= 900; i += 1) {
      mgr.append({ timestamp: new Date(at + i).toISOString(), service: i % 2 === 0 ? "api" : "web", source: i % 5 === 0 ? "stderr" : "stdout", level: i % 50 === 0 ? "ERROR" : "INFO", message: `line ${i} ${i % 7 === 0 ? "多字节文本 ünïcödé 🎉" : ""} ${PAD}`, pid: 1 }, at);
      if (i % 300 === 0) {
        await mgr.flush();
      }
    }
    mgr.append({
      service: "otel", source: "otlp", pid: 0, body: { event: "checkout", nested: { ok: true, n: [1, 2.5, null] } },
      attributes: { "http.route": "/pay/:id", attempt: 3, tags: ["a", "b"] }, resource: { "service.name": "otel", "host.name": "h1" },
      scope: { name: "lib", version: "1.2.3" }, traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1,
      severityNumber: 9, severityText: "INFO", timeUnixNano: (at + 5) * 1_000_000, observedTimeUnixNano: (at + 6) * 1_000_000, raw: "{\"k\":\"原始\"}",
    }, at);
    // One line re-tagged while it still waits in the writer's batch, one after
    // it was written. The pairs are a second apart, so each hop tags its own line.
    workerLine(mgr, at);
    mgr.queryPage({}, { limit: 1 });
    hopPair(mgr, at, "req-in-batch");
    workerLine(mgr, at + 1_000);
    await mgr.flush();
    hopPair(mgr, at + 1_000, "req-after-write");
    await mgr.flush();
    const dir = mgr.sessionDir();
    expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length).toBeGreaterThan(4);
    expect(readdirSync(dir).filter((name) => name.endsWith(".patch"))).toEqual(["worker.patch"]);

    const fromRing = everything(mgr, "lossless");
    expect(mgr.evictedBytesRead()).toBe(0);
    expect(fromRing).toHaveLength(905);
    expect(fromRing.filter((event) => event.service === "worker").map((event) => event.attributes[REQUEST_ID_ATTR])).toEqual(["req-in-batch", "req-after-write"]);

    mgr.setMemoryBudget(16 * 1024);
    expect(mgr.snapshot().total).toBeLessThan(20);
    const fromDisk = everything(mgr, "lossless");
    expect(mgr.evictedBytesRead()).toBeGreaterThan(1024 * 1024);
    expect(fromDisk).toEqual(fromRing);

    // The other readers of a session directory agree.
    await mgr.close();
    expect(loadSessionEvents("session-lossless", root)).toEqual(fromRing);
    expect(loadSessionTail("session-lossless", root)).toEqual(fromRing);
    const history = new SessionHistory(root, 64 * 1024 * 1024, 10_000);
    expect(history.page("session-lossless", {}, { cursor: "0", direction: "forward", limit: 5_000 }).events).toEqual(fromRing);
  });

  test("a patch that arrives after a range was scanned is seen by the next query", async () => {
    const mgr = new LogManager(2_000, undefined, new Detector([], []), true, tmp(), "late", 0, 0, { maxMemoryBytes: 32 * 1024 });
    const at = Date.now();
    workerLine(mgr, at);
    // Commits the worker line's fold, so it is seq 1 and the first evicted.
    mgr.queryPage({}, { limit: 1 });
    for (let i = 1; i <= 300; i += 1) {
      mgr.append({ timestamp: new Date(at + 1).toISOString(), service: "api", source: "stdout", level: "INFO", message: `line ${i} ${PAD}`, pid: 1 }, at + 1);
    }
    await mgr.flush();
    // The worker line is on disk and untagged; this scan is remembered.
    expect(mgr.queryPage({ requestId: "req-late" }, {}).events).toEqual([]);
    hopPair(mgr, at, "req-late");
    await mgr.flush();
    const tagged = mgr.queryPage({ requestId: "req-late" }, {});
    expect(tagged.events.map((event) => `${event.service}:${event.seq}`)).toEqual(["worker:1", "proxy:302"]);
    expect(mgr.queryPage({ requestId: "req-late" }, {}).events).toEqual(tagged.events);
    await mgr.close();
  });

  test("a patch stands in for a line that was never written", () => {
    const dir = tmp();
    const record = (seq: number, body = `line ${seq}`): LogRecord => logRecord({ seq, service: "api", message: body });
    writeLines(dir, "api.jsonl", [record(1), record(2), record(4)]);
    writeLines(dir, "api.patch", [record(3, "patched in"), record(2, "replaced")]);
    const reader = new SessionReader(dir);
    const page = pageSource(reader.source({ matches: () => true }, 1, 5, readBudget(1024 * 1024, 1_000)), { cursor: 0, direction: "forward", limit: 10 });
    expect(page.events.map((event) => `${event.seq}:${logMessage(event)}`)).toEqual(["1:line 1", "2:replaced", "3:patched in", "4:line 4"]);
  });
});

describe("the read budget's clock", () => {
  test("a query that is out of time before it reaches disk still moves the walk on", async () => {
    // With no time at all, each poll finishes one span and the cache keeps it.
    const mgr = await filled(1_500, { maxMemoryBytes: 64 * 1024, historyScanMs: 0 });
    let page = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
    let polls = 1;
    while (page.hasPrev && polls < 200) {
      page = mgr.queryPage({ level: "ERROR" }, { limit: 500 });
      polls += 1;
    }
    expect(lineNumbers(page.events)).toEqual(range(1, 1_500).filter((i) => i % 50 === 0));
    await mgr.close();
  });

  test("starts at the first read, not when the query began", () => {
    // A slow walk of the ring comes first; it must not spend the files' time.
    const dir = tmp();
    writeLines(dir, "api.jsonl", range(1, 2_000).map((seq) => logRecord({ seq, service: "api", message: `line ${seq} ${PAD}` })));
    const budget = readBudget(64 * 1024 * 1024, 50);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    const page = pageSource(new SessionReader(dir).source({ matches: () => true }, 1, 2_001, budget), { direction: "backward", limit: 400 });
    expect(page.events.map((event) => event.seq)).toEqual(range(1_601, 2_000));
  });
});

describe("paging a past session's history", () => {
  async function closedSession(count: number, services: string[]): Promise<string> {
    const mgr = await filled(count, { maxMemoryBytes: 64 * 1024, maxSessionBytes: 16 * 1024 * 1024 }, services, "past");
    await mgr.close();
    return join(mgr.sessionDir(), "..");
  }

  test("pages back by cursor from the newest records to the first, past what one budget reads", async () => {
    const root = await closedSession(4_000, ["api", "worker"]);
    // The next daemon's store, with a per-query budget under half the session.
    const reader = new LogManager(100, undefined, undefined, false, root, "next", 0, 0, { historyScanBytes: 4 * 1024 * 1024 });
    const first = reader.historyPage("session-past", {}, { limit: 400 });
    expect(lineNumbers(first.events)).toEqual(range(3_601, 4_000));
    expect(first.prevCursor).toBe("3601");
    expect(first.hasPrev).toBe(true);
    expect(first.hasNext).toBe(false);
    const seen = lineNumbers(first.events);
    let page = first;
    while (page.hasPrev) {
      page = reader.historyPage("session-past", {}, { cursor: page.prevCursor, direction: "backward", limit: 400 });
      seen.unshift(...lineNumbers(page.events));
    }
    expect(seen).toEqual(range(1, 4_000));
    const forward = reader.historyPage("session-past", { services: ["api"], level: "ERROR" }, { cursor: "0", direction: "forward", limit: 5 });
    expect(lineNumbers(forward.events)).toEqual([50, 100, 150, 200, 250]);
    expect(forward.hasNext).toBe(true);
    await reader.close();
  });

  test("unknown, unsafe, and legacy session names page safely", async () => {
    const root = tmp();
    const legacy = join(root, "session-legacy");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "api.log"), "2026-01-01T00:00:01Z api INFO one\n2026-01-01T00:00:02Z api INFO two\n2026-01-01T00:00:03Z api INFO three\n");
    const reader = new LogManager(100, undefined, undefined, false, root, "next", 0, 0);
    const page = reader.historyPage("session-legacy", {}, { limit: 2 });
    expect(page.events.map((event) => logMessage(event))).toEqual(["two", "three"]);
    expect(reader.historyPage("session-legacy", {}, { cursor: page.prevCursor, direction: "backward" }).events.map((event) => logMessage(event))).toEqual(["one"]);
    for (const name of ["session-missing", "../session-legacy", "session-../x", "other"]) {
      expect(reader.historyPage(name, {}, {}).events).toEqual([]);
    }
    await reader.close();
  });

  test("the log worker and its in-process fallback serve the same pages", async () => {
    const root = await closedSession(1_200, ["api"]);
    const config = { max: 100, persist: false, directory: root, sessionID: "next", retentionDays: 0, maxSessionLogs: 0, extraMarkers: [], extraPatterns: [] };
    const worker = await createDaemonLogStore(config, new Bus(16), new Detector([], []));
    const fallback = await createDaemonLogStore(config, new Bus(16), new Detector([], []), { script: new URL("./no-such-worker.ts", import.meta.url), initTimeoutMs: 200 });
    try {
      expect(worker.usingWorker).toBe(true);
      expect(fallback.usingWorker).toBe(false);
      const request = { cursor: "700", direction: "backward" as const, limit: 50 };
      const fromWorker = await worker.logs.historyPage!("session-past", { level: "INFO" }, request);
      const inProcess = await fallback.logs.historyPage!("session-past", { level: "INFO" }, request);
      expect(lineNumbers(fromWorker.events)).toEqual(range(650, 699));
      expect(fromWorker).toEqual(inProcess);
    } finally {
      await worker.logs.close();
      await fallback.logs.close();
    }
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
