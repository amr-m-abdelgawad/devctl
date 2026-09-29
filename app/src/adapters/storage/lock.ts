import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { processState, readSelfStamp, readStamp, sameStamp, type ProcessStamp } from "../process/liveness.ts";

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 5_000;

/** Superset of the v1 `{ pid, socket }` lock. Old readers ignore the extra fields. */
export type LockRecord = {
  v?: number;
  pid: number;
  socket: string;
  startTicks?: string;
  bootId?: string;
  nonce?: string;
  pidNs?: string;
  lstart?: string;
};

export type HeldLock = {
  release: () => void;
  record: LockRecord;
};

export function readLockFile(path: string): LockRecord | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    const socket = (parsed as { socket?: unknown }).socket;
    if (typeof pid !== "number" || typeof socket !== "string") {
      return undefined;
    }
    const record = parsed as LockRecord;
    return {
      v: record.v,
      pid,
      socket,
      startTicks: typeof record.startTicks === "string" ? record.startTicks : undefined,
      bootId: typeof record.bootId === "string" ? record.bootId : undefined,
      nonce: typeof record.nonce === "string" ? record.nonce : undefined,
      pidNs: typeof record.pidNs === "string" ? record.pidNs : undefined,
      lstart: typeof record.lstart === "string" ? record.lstart : undefined,
    };
  } catch {
    return undefined;
  }
}

/** True when the lock was taken in another PID namespace, where its pid names a different process. */
function acrossPidNamespace(record: LockRecord, self: ProcessStamp): boolean {
  return record.pidNs !== undefined && self.pidNs !== undefined && record.pidNs !== self.pidNs;
}

// Bun has no synchronous connect, and a lock check runs under the lock
// mutex, so a child connects: the running Bun from source or npm, or the
// compiled binary acting as Bun (BUN_BE_BUN). The kernel accepts into the
// listen backlog even while the holder's event loop is wedged, so a connect
// means the holder is alive.
const SOCKET_PROBE_MS = 500;
const SOCKET_PROBE_SOURCE = `const s = require("node:net").connect(process.env.DEVCTL_PROBE_SOCKET); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1));`;

export function socketAccepts(socket: string): boolean {
  if (socket === "") {
    return false;
  }
  try {
    const result = spawnSync(process.execPath, ["-e", SOCKET_PROBE_SOURCE], {
      env: { ...process.env, BUN_BE_BUN: "1", DEVCTL_PROBE_SOCKET: socket },
      stdio: "ignore",
      timeout: SOCKET_PROBE_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function lockIsLive(record: LockRecord, self: ProcessStamp = readSelfStamp(), probe = (): boolean => socketAccepts(record.socket)): boolean {
  if (acrossPidNamespace(record, self)) {
    // The pid means nothing here. A holder in another container that shares
    // this state directory still answers on the socket.
    return probe();
  }
  if (processState(record.pid) !== "alive") {
    return false;
  }
  if (record.v !== 2) {
    return true;
  }
  return sameStamp(stampOf(record), readStamp(record.pid));
}

/**
 * Exclusive create under a mutex file. Stale locks are removed only while the
 * mutex is held, and release deletes the lock only when the nonce still matches.
 */
export function acquireLockFile(path: string, socket: string, hold: ProcessStamp = readSelfStamp()): HeldLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mutex = `${path}.mutex`;
  acquireMutex(mutex);
  try {
    const existing = readLockFile(path);
    if (existing && lockIsLive(existing, hold)) {
      throw new Error(`supervisor already running (pid ${existing.pid})`);
    }
    if (existing) {
      unlinkIfPresent(path);
    }
    const record = createRecord(socket, hold);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    return {
      record,
      release: () => releaseLockFile(path, record.nonce ?? ""),
    };
  } finally {
    unlinkIfPresent(mutex);
  }
}

export function releaseLockFile(path: string, nonce: string): void {
  const mutex = `${path}.mutex`;
  try {
    acquireMutex(mutex);
  } catch {
    return;
  }
  try {
    const current = readLockFile(path);
    if (current?.nonce === nonce) {
      unlinkIfPresent(path);
    }
  } finally {
    unlinkIfPresent(mutex);
  }
}

function createRecord(socket: string, hold: ProcessStamp): LockRecord {
  return {
    v: 2,
    pid: process.pid,
    socket,
    startTicks: hold.startTicks,
    bootId: hold.bootId,
    nonce: randomBytes(16).toString("hex"),
    pidNs: hold.pidNs,
    lstart: hold.lstart,
  };
}

function stampOf(record: LockRecord): ProcessStamp {
  return { startTicks: record.startTicks, bootId: record.bootId, pidNs: record.pidNs, lstart: record.lstart };
}

/**
 * Takes a `"wx"` mutex without waiting. Returns its release, or undefined
 * while another process holds it. A mutex older than the stale limit belonged
 * to a process that died holding it and is taken over.
 */
export function tryMutex(lock: string): (() => void) | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      return () => unlinkIfPresent(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return undefined;
      }
    }
    try {
      if (Date.now() - statMtime(lock) <= LOCK_STALE_MS) {
        return undefined;
      }
      unlinkIfPresent(lock);
    } catch {
      // released between the attempts
    }
  }
  return undefined;
}

function acquireMutex(lock: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    try {
      const age = Date.now() - statMtime(lock);
      if (age > LOCK_STALE_MS) {
        unlinkIfPresent(lock);
      }
    } catch {
      // raced with the holder
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${lock}`);
    }
    Bun.sleepSync(20);
  }
}

function statMtime(path: string): number {
  return statSync(path).mtimeMs;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
