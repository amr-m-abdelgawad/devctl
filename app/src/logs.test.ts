import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Detector } from "./secrets.ts";
import { clampLogPageSize, compileLogSearch, DEFAULT_LOG_PAGE_SIZE, defaultExportPath, LogManager, MAX_LOG_PAGE_SIZE, matchLog, pruneSessions, resolveExportPath, writeLogExport } from "./logs.ts";
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
