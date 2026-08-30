import { mkdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { acquireLock, lockPath, newSessionID, processAlive, readPersistedState, sessionStartedAt, socketPath, statePath, writePersistedState } from "./storage.ts";

describe("session storage", () => {
  test("Windows attach uses a named pipe, Unix uses devctl.sock", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-sock-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    expect(socketPath("/repo", "win32")).toMatch(/^\\\\.\\pipe\\devctl-[0-9a-f]{16}$/);
    const unix = socketPath("/repo", "darwin");
    expect(unix.endsWith("devctl.sock")).toBe(true);
    expect(unix.replaceAll("\\", "/")).toContain("/state/");
  });

  test("session IDs use timestamp plus random suffix", () => {
    const id = newSessionID(new Date("2026-08-30T00:00:00.000Z"));
    expect(id.startsWith("2026-08-30T00-00-00Z-")).toBe(true);
    expect(id.length).toBeGreaterThan(22);
  });

  test("sessionStartedAt reverses newSessionID's format", () => {
    const fixed = new Date("2026-08-30T14:22:07.000Z");
    const id = newSessionID(fixed);
    expect(sessionStartedAt(id)?.getTime()).toBe(fixed.getTime());
    expect(sessionStartedAt("not-a-session-id")).toBeUndefined();
    expect(sessionStartedAt("")).toBeUndefined();
  });

  test("persisted process state round-trips", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-state-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    writePersistedState("/repo", {
      session_id: "2026-08-30T00-00-00Z-abc123",
      repo_root: "/repo",
      profile: "backend",
      processes: [{ name: "api", pid: 12, command: ["python", "main.py"], cwd: "/repo/api", startTime: "2026-08-30T00:00:00Z", ports: { http: 18000 } }],
    });
    const loaded = readPersistedState("/repo");
    expect(loaded?.profile).toBe("backend");
    expect(loaded?.processes[0]?.command).toEqual(["python", "main.py"]);
    expect(loaded?.processes[0]?.ports.http).toBe(18000);
    if (process.platform !== "win32") {
      const mode = statSync(statePath("/repo")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("processAlive sees this process and not a missing pid", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(999_999_999)).toBe(false);
  });

  test("acquireLock replaces a stale lock and release removes it", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-lock-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    writeFileSync(lockPath("/repo"), JSON.stringify({ pid: 999_999_999, socket: "/tmp/dead" }));
    const lock = acquireLock("/repo", "/tmp/sock");
    expect(processAlive(process.pid)).toBe(true);
    lock.release();
    expect(existsSync(lockPath("/repo"))).toBe(false);
  });
});
