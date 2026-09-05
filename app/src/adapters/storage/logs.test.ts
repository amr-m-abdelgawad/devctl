import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import {
  clampLogPageSize,
  compileLogSearch,
  DEFAULT_LOG_PAGE_SIZE,
  defaultExportPath,
  defaultLogParser,
  LogManager,
  MAX_LOG_PAGE_SIZE,
  matchLog,
  parseJSONLogLine,
  pruneSessions,
  resolveExportPath,
  writeLogExport,
} from "./logs.ts";
import { exportsDir } from "./storage.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("LogManager persistence", () => {
  test("circular buffer retains the newest events in chronological order", () => {
    const mgr = new LogManager(3, undefined, new Detector([], []), false, tmp(), "ring", 0, 0);
    for (let index = 0; index < 6; index += 1) {
      mgr.append({
        timestamp: `2026-08-30T00:00:0${index}.000Z`,
        service: "api",
        source: "stdout",
        level: index === 5 ? "ERROR" : "INFO",
        message: `line ${index}`,
        pid: 1,
      });
    }

    expect(mgr.query({}).map((event) => event.message)).toEqual(["line 3", "line 4", "line 5"]);
    expect(mgr.snapshot()).toEqual({ total: 3, errors: 1, counts: { api: 3 } });
  });

  test("writes redacted lines to the session file", async () => {
    const dir = tmp();
    const mgr = new LogManager(100, undefined, new Detector([], []), true, dir, "abc", 0, 0);
    mgr.append({
      timestamp: "2026-08-30T00:00:00.000Z",
      service: "api",
      source: "stdout",
      level: "INFO",
      message: "Authorization: Bearer super-secret-token",
      pid: 1,
    });
    // Persistence is asynchronous now (no more blocking appendFileSync per
    // line); flush() waits for the write to actually land before we read it back.
    await mgr.flush();
    const file = join(mgr.sessionDir(), "api.log");
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toContain("********");
    expect(body).not.toContain("super-secret-token");
  });

  test("pruneSessions drops old and over-cap sessions", () => {
    const dir = tmp();
    const oldDir = join(dir, "session-old");
    const newDir = join(dir, "session-new");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, "x.log"), "old\n");
    writeFileSync(join(newDir, "x.log"), "new\n");
    const past = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(oldDir, past, past);
    pruneSessions(dir, 1, 0);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    mkdirSync(oldDir);
    pruneSessions(dir, 0, 1);
    const left = [oldDir, newDir].filter((path) => existsSync(path));
    expect(left.length).toBe(1);
  });

  test("structured JSON log lines show the extracted message, not the raw blob", async () => {
    const mgr = new LogManager(100, undefined, new Detector([], []), true, tmp(), "json", 0, 0);
    mgr.setParsers([defaultLogParser()]);
    mgr.append({
      timestamp: "2026-08-30T00:00:00.000Z",
      service: "api",
      source: "stdout",
      level: "",
      message: '{"level":"error","msg":"db connection refused","request_id":"req-42"}',
      pid: 1,
    });
    const [ev] = mgr.query({});
    expect(ev?.message).toBe("db connection refused");
    expect(ev?.level).toBe("ERROR");
    expect(ev?.request_id).toBe("req-42");
    expect(ev?.raw).toBe('{"level":"error","msg":"db connection refused","request_id":"req-42"}');

    // the persisted session file keeps the full raw JSON, not the shortened message
    await mgr.flush();
    const body = readFileSync(join(mgr.sessionDir(), "api.log"), "utf8");
    expect(body).toContain('"msg":"db connection refused"');
  });

  test("pino's numeric level convention maps to named levels", () => {
    const mgr = new LogManager(100, undefined, new Detector([], []), false, tmp(), "pino", 0, 0);
    mgr.setParsers([defaultLogParser()]);
    mgr.append({
      timestamp: "2026-08-30T00:00:00.000Z",
      service: "api",
      source: "stdout",
      level: "",
      message: '{"level":30,"msg":"listening"}',
      pid: 1,
    });
    expect(mgr.query({})[0]?.level).toBe("INFO");
  });

  test("non-JSON and unrecognized JSON lines pass through unchanged", () => {
    expect(parseJSONLogLine("plain text line")).toBeUndefined();
    expect(parseJSONLogLine("[1, 2, 3]")).toBeUndefined();
    expect(parseJSONLogLine("{not valid json}")).toBeUndefined();
    expect(parseJSONLogLine('{"foo":"bar"}')).toBeUndefined();
  });

  test("matchLog searches the raw JSON payload as well as the extracted message", () => {
    const ev = {
      timestamp: "2026-08-30T00:00:00.000Z",
      service: "api",
      source: "stdout",
      level: "ERROR",
      message: "db connection refused",
      raw: '{"level":"error","msg":"db connection refused","host":"pg-primary"}',
      pid: 1,
      seq: 1,
    };
    expect(matchLog({ search: "pg-primary" }, ev)).toBe(true);
    expect(matchLog({ search: "connection refused" }, ev)).toBe(true);
    expect(matchLog({ search: "no match here" }, ev)).toBe(false);
  });

  test("matchLog filters identity time range and source", () => {
    const ev = {
      timestamp: "2026-08-30T12:00:00.000Z",
      service: "api",
      source: "proxy",
      level: "INFO",
      message: "ok",
      pid: 1,
      identity: "user",
      seq: 1,
    };
    expect(matchLog({ source: "proxy", since: "2026-08-30T00:00:00.000Z", until: "2026-08-30T23:00:00.000Z" }, ev)).toBe(true);
    expect(matchLog({ source: "stdout" }, ev)).toBe(false);
    expect(matchLog({ since: "2026-08-31T00:00:00.000Z" }, ev)).toBe(false);
    expect(matchLog({ regex: true, search: "^ok" }, ev)).toBe(true);
    expect(matchLog({ regex: true, search: "^fail" }, ev)).toBe(false);
    expect(matchLog({ regex: true, search: "(a+)+" }, { ...ev, message: "aaaa" })).toBe(false);
  });

  test("compileLogSearch rejects nested and oversized patterns", () => {
    expect(compileLogSearch("^ok")?.test("ok")).toBe(true);
    expect(compileLogSearch("err(or|no)")?.test("errno")).toBe(true);
    expect(compileLogSearch("a+")?.test("aaa")).toBe(true);
    expect(compileLogSearch("(a+)+")).toBeUndefined();
    expect(compileLogSearch("a{65}")).toBeUndefined();
    expect(compileLogSearch("[")).toBeUndefined();
    expect(compileLogSearch("x".repeat(201))).toBeUndefined();
  });
});

describe("LogManager pagination", () => {
  // Events 4, 5, and 6 deliberately share one timestamp so a page boundary
  // can land inside that cluster — the scenario a timestamp-based cursor
  // can't page correctly (it would either duplicate or drop whichever of
  // the tied events falls on the wrong side), but a sequence-based one can.
  function seeded(sessionID = "s1"): LogManager {
    const mgr = new LogManager(1000, undefined, new Detector([], []), false, tmp(), sessionID, 0, 0);
    for (let i = 1; i <= 10; i += 1) {
      const tied = i >= 4 && i <= 6;
      mgr.append({
        timestamp: tied ? "2026-08-30T00:00:04.000Z" : `2026-08-30T00:00:${String(i).padStart(2, "0")}.000Z`,
        service: "api",
        source: "stdout",
        level: "INFO",
        message: `line ${i}`,
        pid: 1,
      });
    }
    return mgr;
  }

  test("with no cursor, returns the latest page and reports more history behind it", () => {
    const mgr = seeded();
    const page = mgr.queryPage({}, { limit: 5 });
    expect(page.events.map((ev) => ev.message)).toEqual(["line 6", "line 7", "line 8", "line 9", "line 10"]);
    expect(page.hasPrev).toBe(true);
    expect(page.hasNext).toBe(false);
    expect(page.sessionChanged).toBe(false);
  });

  test("backward paging splits a same-timestamp cluster across pages without gap or duplication", () => {
    const mgr = seeded();
    const latest = mgr.queryPage({}, { limit: 5 }); // line 6..10 (line 6 shares ts with 4 and 5)
    const older = mgr.queryPage({}, { cursor: latest.prevCursor, direction: "backward", limit: 5 });
    // line 4 and 5 share line 6's exact timestamp but must still land in the
    // earlier page, not be re-included here or dropped entirely.
    expect(older.events.map((ev) => ev.message)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
    expect(older.hasPrev).toBe(false);
    expect(older.hasNext).toBe(true);
  });

  test("forward paging from history reconstructs the exact original sequence, tie included", () => {
    const mgr = seeded();
    const latest = mgr.queryPage({}, { limit: 5 });
    const older = mgr.queryPage({}, { cursor: latest.prevCursor, direction: "backward", limit: 5 });
    expect(older.hasPrev).toBe(false);
    // Walking forward from the oldest page's own nextCursor must reproduce
    // exactly the newer page already fetched — no repeat of line 5, no skip
    // of line 6, despite the tied timestamp straddling the boundary.
    const caughtUp = mgr.queryPage({}, { cursor: older.nextCursor, direction: "forward", limit: 5 });
    expect(caughtUp.events.map((ev) => ev.message)).toEqual(latest.events.map((ev) => ev.message));
    expect(caughtUp.hasNext).toBe(false);
  });

  test("a cursor from a prior daemon session is reported as changed and treated as absent", () => {
    const before = seeded("session-a").queryPage({}, { limit: 3 });
    const restarted = seeded("session-b");
    const page = restarted.queryPage({}, { cursor: before.nextCursor, direction: "forward", limit: 3 });
    expect(page.sessionChanged).toBe(true);
    // Ignored, not rejected: falls back to the latest page of the new session.
    expect(page.events.map((ev) => ev.message)).toEqual(["line 8", "line 9", "line 10"]);
  });

  test("filters apply before pagination, so a page respects them like an unbounded query would", () => {
    const mgr = new LogManager(1000, undefined, new Detector([], []), false, tmp(), "s1", 0, 0);
    for (let i = 1; i <= 6; i += 1) {
      mgr.append({
        timestamp: `2026-08-30T00:00:0${i}.000Z`,
        service: i % 2 === 0 ? "api" : "worker",
        source: "stdout",
        level: "INFO",
        message: `line ${i}`,
        pid: 1,
      });
    }
    const page = mgr.queryPage({ services: ["api"] }, { limit: 10 });
    expect(page.events.map((ev) => ev.message)).toEqual(["line 2", "line 4", "line 6"]);
    expect(page.hasPrev).toBe(false);
  });

  test("clampLogPageSize enforces the default and maximum page sizes", () => {
    expect(clampLogPageSize(undefined)).toBe(DEFAULT_LOG_PAGE_SIZE);
    expect(clampLogPageSize(0)).toBe(DEFAULT_LOG_PAGE_SIZE);
    expect(clampLogPageSize(-5)).toBe(DEFAULT_LOG_PAGE_SIZE);
    expect(clampLogPageSize(1.5)).toBe(DEFAULT_LOG_PAGE_SIZE);
    expect(clampLogPageSize(10)).toBe(10);
    expect(clampLogPageSize(MAX_LOG_PAGE_SIZE)).toBe(MAX_LOG_PAGE_SIZE);
    expect(clampLogPageSize(MAX_LOG_PAGE_SIZE + 1)).toBe(MAX_LOG_PAGE_SIZE);
  });
});

describe("LogManager facets", () => {
  function seededMixed(): LogManager {
    const mgr = new LogManager(1000, undefined, new Detector([], []), false, tmp(), "s1", 0, 0);
    const rows: Array<[string, string, string]> = [
      ["api", "INFO", "stdout"],
      ["api", "ERROR", "stdout"],
      ["api", "ERROR", "stderr"],
      ["worker", "INFO", "stdout"],
      ["worker", "INFO", "stderr"],
      ["worker", "ERROR", "stderr"],
    ];
    rows.forEach(([service, level, source], i) => {
      mgr.append({ timestamp: `2026-08-30T00:00:0${i}.000Z`, service, source, level, message: `line ${i}`, pid: 1 });
    });
    return mgr;
  }

  test("total respects every active filter, matching what query() itself would return", () => {
    const mgr = seededMixed();
    const facets = mgr.queryFacets({ services: ["api"], level: "ERROR" });
    expect(facets.total).toBe(mgr.query({ services: ["api"], level: "ERROR" }).length);
    expect(facets.total).toBe(2);
  });

  test("byService ignores the services filter but keeps every other one active", () => {
    const mgr = seededMixed();
    // Filtered down to api, but byService must still show worker's own
    // count under the same level filter — that's the whole point of a
    // service-picker facet: showing what switching services would yield.
    const facets = mgr.queryFacets({ services: ["api"], level: "ERROR" });
    expect(facets.byService).toEqual({ api: 2, worker: 1 });
  });

  test("byLevel and bySource each ignore only their own dimension", () => {
    const mgr = seededMixed();
    const facets = mgr.queryFacets({ level: "ERROR", source: "stderr" });
    // byLevel: source stays applied (stderr), level does not.
    expect(facets.byLevel).toEqual({ ERROR: 2, INFO: 1 });
    // bySource: level stays applied (ERROR), source does not.
    expect(facets.bySource).toEqual({ stdout: 1, stderr: 2 });
  });
});

describe("LogManager at scale", () => {
  // The plan's named acceptance scenario: cfg.logs.max_memory_events and
  // LogManager's own DEFAULT_MAX_EVENTS both default to 50,000, so this is
  // the largest buffer the TUI is expected to hold. queryPage()/queryFacets()
  // scan the whole ring buffer every call (there's no secondary index) to
  // compute hasNext/hasPrev/facet counts correctly, so this exists to prove
  // that scan stays fast enough in practice that the TUI never visibly
  // stalls at the cap, not just that it's correct at a handful of events.
  function filled(count: number): LogManager {
    const mgr = new LogManager(count, undefined, new Detector([], []), false, tmp(), "scale", 0, 0);
    const services = ["api", "worker", "auth"];
    for (let i = 0; i < count; i += 1) {
      mgr.append({
        timestamp: new Date(2026, 7, 30, 0, 0, 0, i).toISOString(),
        service: services[i % services.length]!,
        source: "stdout",
        level: i % 97 === 0 ? "ERROR" : "INFO",
        message: `line ${i}`,
        pid: 1,
      });
    }
    return mgr;
  }

  test("queryPage returns a tightly bounded page fast at a full 50,000-event buffer", () => {
    const mgr = filled(50_000);
    const started = performance.now();
    const page = mgr.queryPage({}, { limit: 500 });
    const elapsed = performance.now() - started;
    expect(page.events).toHaveLength(500);
    expect(page.events[0]?.message).toBe("line 49500");
    expect(page.events[499]?.message).toBe("line 49999");
    expect(page.hasPrev).toBe(true);
    expect(page.hasNext).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });

  test("queryFacets stays correct and fast at a full 50,000-event buffer", () => {
    const mgr = filled(50_000);
    const started = performance.now();
    const facets = mgr.queryFacets({});
    const elapsed = performance.now() - started;
    expect(facets.total).toBe(50_000);
    expect(facets.byService.api).toBe(mgr.query({ services: ["api"] }).length);
    expect(elapsed).toBeLessThan(2000);
  });

  test("paging backward through the entire 50,000-event history visits every event exactly once", () => {
    const mgr = filled(50_000);
    let cursor: string | undefined;
    const seen = new Set<number>();
    let hasPrev = true;
    let pages = 0;
    while (hasPrev) {
      const page = mgr.queryPage({}, { cursor, direction: "backward", limit: 5000 });
      for (const ev of page.events) {
        const n = Number(ev.message.replace("line ", ""));
        expect(seen.has(n)).toBe(false);
        seen.add(n);
      }
      hasPrev = page.hasPrev;
      cursor = page.prevCursor;
      pages += 1;
      // Sanity bound so a boundary bug fails fast instead of looping.
      expect(pages).toBeLessThan(20);
    }
    expect(seen.size).toBe(50_000);
  });
});

describe("log export paths", () => {
  test("defaultExportPath writes under DEVCTL_HOME/exports", () => {
    const home = tmp();
    const prev = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = home;
    try {
      const now = new Date("2026-08-30T12:34:56.789Z");
      expect(defaultExportPath(now)).toBe(join(home, "exports", "devctl-logs-2026-08-30T12-34-56-789Z.log"));
    } finally {
      if (prev === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prev;
      }
    }
  });

  test("resolveExportPath expands home, relatives, and blanks", () => {
    const home = tmp();
    const prev = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = home;
    try {
      const dest = resolveExportPath("");
      expect(dest.startsWith(join(exportsDir(), "devctl-logs-"))).toBe(true);
      expect(dest.endsWith(".log")).toBe(true);
      expect(resolveExportPath("~/out.log")).toBe(join(homedir(), "out.log"));
      expect(resolveExportPath("out.log")).toBe(join(process.cwd(), "out.log"));
      expect(resolveExportPath("/abs/out.log")).toBe("/abs/out.log");
    } finally {
      if (prev === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prev;
      }
    }
  });

  test("writeLogExport and exportTo create the parent directory", () => {
    const dest = join(tmp(), "nested", "out.log");
    writeLogExport(dest, [
      {
        timestamp: "2026-08-30T00:00:00.000Z",
        service: "api",
        source: "stdout",
        level: "INFO",
        message: "hello",
        pid: 1,
        seq: 1,
      },
    ]);
    expect(readFileSync(dest, "utf8")).toBe("2026-08-30T00:00:00.000Z api INFO hello\n");

    const nested = join(tmp(), "also", "nested", "session.log");
    const mgr = new LogManager(100, undefined, new Detector([], []), false, tmp(), "export", 0, 0);
    mgr.append({
      timestamp: "2026-08-30T00:00:01.000Z",
      service: "api",
      source: "stdout",
      level: "WARN",
      message: "late",
      pid: 2,
    });
    mgr.exportTo(nested, {});
    expect(readFileSync(nested, "utf8")).toContain("api WARN late");
  });
});
