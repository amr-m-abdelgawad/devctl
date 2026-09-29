import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../../domain/logs/logs.ts";
import { processState, readSelfStamp, readStamp, sameStamp, type ProcessStamp } from "../process/liveness.ts";
import { tryMutex } from "./lock.ts";
import { SESSION_PREFIX } from "./session-files.ts";

// A session with no owner stamp (written by an older daemon) counts as live
// while any of its files changed this recently.
const UNOWNED_LIVE_MS = 10 * 60_000;

/** The daemon writing a session. The pruner never deletes a session whose owner still runs. */
export type SessionOwner = { pid: number } & ProcessStamp;

type PruneOptions = {
  maxTotalBytes?: number;
  liveDir?: string;
};

/**
 * Deletes sessions past retention, past the per-repo count, and oldest-first
 * past the shared byte cap. A session whose owning daemon is still running is
 * never deleted, whichever repo it belongs to. Runs under a root-wide mutex;
 * when another daemon is already pruning this root, this call does nothing.
 */
export function pruneSessions(root: string, retentionDays: number, maxSessionLogs: number, repoKey?: string, options: PruneOptions = {}): void {
  if (!existsSync(root)) {
    return;
  }
  const release = tryMutex(join(root, PRUNE_MUTEX));
  if (release === undefined) {
    return;
  }
  try {
    pruneSessionsLocked(root, retentionDays, maxSessionLogs, repoKey, options);
  } finally {
    release();
  }
}

function pruneSessionsLocked(root: string, retentionDays: number, maxSessionLogs: number, repoKey: string | undefined, options: PruneOptions): void {
  const sessions = readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => {
      const path = join(root, name);
      const st = statSync(path);
      const manifest = readSessionManifest(path);
      return {
        path,
        mtime: st.mtimeMs,
        repo: typeof manifest?.repo === "string" ? manifest.repo : "",
        retentionDays: typeof manifest?.retentionDays === "number" ? manifest.retentionDays : 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  const counted = repoKey === undefined ? sessions : sessions.filter((session) => session.repo === repoKey);
  const countedPaths = new Set(counted.map((session) => session.path));
  sessions.forEach((session, index) => {
    const inCount = repoKey === undefined || countedPaths.has(session.path);
    const countIndex = repoKey === undefined ? index : counted.findIndex((row) => row.path === session.path);
    // This repo's sessions (and unlabeled ones) follow this daemon's retention;
    // another repo's sessions follow the retention recorded when they were written.
    const ownRules = repoKey === undefined || session.repo === repoKey || session.repo === "";
    const days = ownRules ? retentionDays : session.retentionDays;
    const tooOld = days > 0 && session.mtime < now - days * 86_400_000;
    const overCap = inCount && maxSessionLogs > 0 && countIndex >= maxSessionLogs;
    if ((tooOld || overCap) && session.path !== options.liveDir && !sessionOwnerRunning(session.path)) {
      rmSync(session.path, { recursive: true, force: true });
    }
  });
  pruneSessionBytes(root, options.maxTotalBytes ?? 0, options.liveDir);
}

const PRUNE_MUTEX = ".prune.lock";

function sessionOwnerRunning(dir: string): boolean {
  const manifest = readSessionManifest(dir);
  if (manifest === undefined || typeof manifest.closedAt === "string") {
    return false;
  }
  const owner = manifest.owner;
  if (typeof owner !== "object" || owner === null || typeof (owner as { pid?: unknown }).pid !== "number") {
    return newestFileAgeMs(dir) < UNOWNED_LIVE_MS;
  }
  const held = owner as SessionOwner;
  if (processState(held.pid) !== "alive") {
    return false;
  }
  return sameStamp(held, held.pid === process.pid ? readSelfStamp() : readStamp(held.pid));
}

function readSessionManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function newestFileAgeMs(dir: string): number {
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
    }
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - newest;
}

function pruneSessionBytes(root: string, maxTotalBytes: number, liveDir?: string): void {
  if (maxTotalBytes <= 0 || !existsSync(root)) {
    return;
  }
  const sessions = readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => {
      const path = join(root, name);
      return { path, mtime: statSync(path).mtimeMs, bytes: directorySize(path) };
    })
    .filter((session) => session.path !== liveDir)
    .sort((a, b) => a.mtime - b.mtime);
  let total = sessions.reduce((sum, session) => sum + session.bytes, 0);
  if (liveDir !== undefined && existsSync(liveDir)) {
    total += directorySize(liveDir);
  }
  for (const session of sessions) {
    if (total <= maxTotalBytes) {
      return;
    }
    if (sessionOwnerRunning(session.path)) {
      continue;
    }
    rmSync(session.path, { recursive: true, force: true });
    total -= session.bytes;
  }
}

function directorySize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    total += st.isDirectory() ? directorySize(path) : st.size;
  }
  return total;
}
