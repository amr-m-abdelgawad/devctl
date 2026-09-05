import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { acquireLock, BOOTSTRAP_LOG_HISTORY, bootstrapLogPath, lockPath, mcpTokenPath, newSessionID, processAlive, readOrCreateMcpToken, readPersistedState, repoID, rotateBootstrapLog, sessionDir, sessionStartedAt, socketPath, statePath, writePersistedState } from "./storage.ts";

describe("session storage", () => {
  test("equivalent repository path spellings share one state identity", () => {
    expect(repoID(".")).toBe(repoID(process.cwd()));
    expect(repoID(`${process.cwd()}//`)).toBe(repoID(process.cwd()));
    expect(repoID(join(process.cwd(), "nested", ".."))).toBe(repoID(process.cwd()));
  });

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

  test("MCP token survives restarts instead of rotating every launch", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-mcp-token-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    expect(existsSync(mcpTokenPath("/repo"))).toBe(false);
    const first = readOrCreateMcpToken("/repo");
    expect(first.length).toBeGreaterThan(0);
    expect(existsSync(mcpTokenPath("/repo"))).toBe(true);
    // A second "process" (fresh call) reads the same token back rather than minting a new one.
    expect(readOrCreateMcpToken("/repo")).toBe(first);
    // Different repos never share a token.
    expect(readOrCreateMcpToken("/other-repo")).not.toBe(first);
    // Deleting the token file is how a user opts back into rotation.
    writeFileSync(mcpTokenPath("/repo"), "");
    expect(readOrCreateMcpToken("/repo")).not.toBe(first);
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

  test("rotateBootstrapLog preserves the previous boot attempt instead of letting it be silently truncated", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-bootstrap-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    // No prior attempt yet — nothing to rotate, must not throw.
    rotateBootstrapLog("/repo");
    expect(existsSync(bootstrapLogPath("/repo"))).toBe(false);

    writeFileSync(bootstrapLogPath("/repo"), "first boot attempt failed: EADDRINUSE");
    rotateBootstrapLog("/repo");
    // The canonical path is clear again, ready for Bun.file() to open fresh...
    expect(existsSync(bootstrapLogPath("/repo"))).toBe(false);
    // ...but the content that was there is still readable under a rotated name.
    const rotated = readdirSync(sessionDir("/repo")).filter((name) => name.startsWith("bootstrap-"));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(`${sessionDir("/repo")}/${rotated[0]}`, "utf8")).toBe("first boot attempt failed: EADDRINUSE");
  });

  test("rotateBootstrapLog keeps only the most recent BOOTSTRAP_LOG_HISTORY attempts", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-bootstrap-cap-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    const dirPath = sessionDir("/repo");
    const stamped = new Set<string>();
    const total = BOOTSTRAP_LOG_HISTORY + 3;
    for (let i = 0; i < total; i++) {
      writeFileSync(bootstrapLogPath("/repo"), `attempt ${i}`);
      rotateBootstrapLog("/repo");
      // This loop runs far faster than real crash-loop restarts (each of
      // which pays real process-spawn overhead) would, so distinct mtimes
      // aren't guaranteed by natural timing alone here — pin each rotated
      // file's mtime to its real attempt order as soon as it's created, a
      // comfortably-past date so it can never be mistaken for "newest" by a
      // later iteration's own (real, "now") unstamped file.
      const justRotated = readdirSync(dirPath)
        .filter((name) => name.startsWith("bootstrap-") && !stamped.has(name));
      for (const name of justRotated) {
        stamped.add(name);
        const at = new Date(2000, 0, 1, 0, 0, i);
        utimesSync(`${dirPath}/${name}`, at, at);
      }
    }
    const remaining = readdirSync(dirPath).filter((name) => name.startsWith("bootstrap-"));
    expect(remaining).toHaveLength(BOOTSTRAP_LOG_HISTORY);
    // The oldest attempts (0, 1, 2) must be the ones pruned, not the newest.
    const contents = remaining.map((name) => readFileSync(`${dirPath}/${name}`, "utf8"));
    expect(contents).not.toContain("attempt 0");
    expect(contents).toContain(`attempt ${total - 1}`);
  });
});
