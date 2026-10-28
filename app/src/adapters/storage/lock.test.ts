import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readSelfStamp, readStamp } from "../process/liveness.ts";
import { lockIsLive, socketAccepts, type LockRecord } from "./lock.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devctl-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function listen(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.listen(path, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("lock across a PID namespace boundary", () => {
  // A daemon in another container that shares DEVCTL_HOME: its pid is not a
  // process here, so only its socket can say whether it is still running.
  const otherNamespace = { pidNs: "pid:[4026531836]" };
  const here = { pidNs: "pid:[4026532695]" };

  test.skipIf(process.platform === "win32")("is live while the holder's socket accepts, whatever its pid names here", async () => {
    const socket = join(dir, "devctl.sock");
    const record: LockRecord = { v: 2, pid: process.pid + 1_000_000, socket, ...otherNamespace };
    const server = await listen(socket);
    try {
      expect(socketAccepts(socket)).toBe(true);
      expect(lockIsLive(record, here)).toBe(true);
    } finally {
      await close(server);
    }
    expect(socketAccepts(socket)).toBe(false);
    expect(lockIsLive(record, here)).toBe(false);
  });

  test("is not live when nothing ever listened", () => {
    const record: LockRecord = { v: 2, pid: process.pid, socket: join(dir, "missing.sock"), ...otherNamespace };
    expect(lockIsLive(record, here)).toBe(false);
    expect(socketAccepts("")).toBe(false);
  });
});

describe("process stamp", () => {
  test.skipIf(process.platform !== "linux")("reads the pid namespace from its /proc link", () => {
    const stamp = readStamp(process.pid);
    expect(stamp.pidNs).toMatch(/^pid:\[\d+\]$/);
    expect(readSelfStamp().pidNs).toBe(stamp.pidNs);
  });
});
