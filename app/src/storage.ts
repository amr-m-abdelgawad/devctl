import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DIR_PERM = 0o700;
const FILE_PERM = 0o600;
const REPO_ID_LENGTH = 16;

export function homeDir(): string {
  const override = process.env.DEVCTL_HOME;
  if (override && override !== "") {
    return override;
  }
  return join(homedir(), ".devctl");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_PERM });
}

export function repoID(repoRoot: string): string {
  const sum = createHash("sha256").update(repoRoot).digest("hex");
  return sum.slice(0, REPO_ID_LENGTH);
}

export function sessionDir(repoRoot: string): string {
  const next = join(homeDir(), "state", repoID(repoRoot));
  const legacy = join(homeDir(), "sessions", repoID(repoRoot));
  if (!existsSync(next) && existsSync(legacy)) {
    ensureDir(dirname(next));
    try {
      renameSync(legacy, next);
    } catch {
      ensureDir(next);
      for (const name of ["state.json", "devctl.lock", "devctl.sock"]) {
        const from = join(legacy, name);
        if (existsSync(from)) {
          copyFileSync(from, join(next, name));
        }
      }
    }
  }
  ensureDir(next);
  return next;
}

export function logsDir(): string {
  const dir = join(homeDir(), "logs");
  ensureDir(dir);
  return dir;
}

export function exportsDir(): string {
  const dir = join(homeDir(), "exports");
  ensureDir(dir);
  return dir;
}

export function credentialsDir(): string {
  const dir = join(homeDir(), "credentials");
  ensureDir(dir);
  return dir;
}

export function socketPath(repoRoot: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\devctl-${repoID(repoRoot)}`;
  }
  return join(sessionDir(repoRoot), "devctl.sock");
}

export function lockPath(repoRoot: string): string {
  return join(sessionDir(repoRoot), "devctl.lock");
}

export function statePath(repoRoot: string): string {
  return join(sessionDir(repoRoot), "state.json");
}

export function writeFileSecure(path: string, data: string | Buffer): void {
  ensureDir(dirname(path));
  writeFileSync(path, data, { mode: FILE_PERM });
}

export function newSessionID(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-") + "Z";
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export type PersistedProcess = {
  name: string;
  pid: number;
  command: string[];
  cwd: string;
  startTime: string;
  ports: Record<string, number>;
};

export type PersistedState = {
  session_id: string;
  repo_root: string;
  profile: string;
  processes: PersistedProcess[];
};

export function readPersistedState(repoRoot: string): PersistedState | undefined {
  const path = statePath(repoRoot);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedState & { services?: Record<string, unknown> };
    if (Array.isArray(parsed.processes)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writePersistedState(repoRoot: string, state: PersistedState): void {
  writeFileSecure(statePath(repoRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export type LockFile = {
  pid: number;
  socket: string;
};

export function acquireLock(repoRoot: string, socket: string): { release: () => void } {
  const path = lockPath(repoRoot);
  if (existsSync(path)) {
    const existing = readLock(path);
    if (existing && processAlive(existing.pid)) {
      throw new Error(`supervisor already running (pid ${existing.pid})`);
    }
    try {
      unlinkSync(path);
    } catch {
      // stale lock file; overwrite below
    }
  }
  writeFileSecure(path, JSON.stringify({ pid: process.pid, socket }));
  return {
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        // lock already released
      }
    },
  };
}

export function readRepoLock(repoRoot: string): LockFile | undefined {
  return readLock(lockPath(repoRoot));
}

function readLock(path: string): LockFile | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; socket?: string };
    if (typeof parsed.pid === "number" && typeof parsed.socket === "string") {
      return { pid: parsed.pid, socket: parsed.socket };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function processAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function randomSecret(): string {
  return randomBytes(24).toString("hex");
}
