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

export function lockIsLive(record: LockRecord, self: ProcessStamp = readSelfStamp(), probe?: () => boolean): boolean {
  if (record.pidNs !== undefined && self.pidNs !== undefined && record.pidNs !== self.pidNs) {
    if (probe) {
      return probe();
    }
    return processState(record.pid) === "alive";
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
