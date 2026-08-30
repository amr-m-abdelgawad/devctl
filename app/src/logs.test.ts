import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Detector } from "./secrets.ts";
import { defaultExportPath, LogManager, matchLog, pruneSessions, resolveExportPath, writeLogExport } from "./logs.ts";
import { exportsDir } from "./storage.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("LogManager persistence", () => {
  test("writes redacted lines to the session file", () => {
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
    };
    expect(matchLog({ source: "proxy", since: "2026-08-30T00:00:00.000Z", until: "2026-08-30T23:00:00.000Z" }, ev)).toBe(true);
    expect(matchLog({ source: "stdout" }, ev)).toBe(false);
    expect(matchLog({ since: "2026-08-31T00:00:00.000Z" }, ev)).toBe(false);
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
