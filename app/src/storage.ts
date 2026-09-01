import { spawnSync } from "node:child_process";
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

export function socketPath(repoRoot: string, platform = process.platform): string {
  if (platform === "win32") {
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

// Reverses newSessionID()'s format to recover the moment the session
// started, so uptime can be derived from session_id alone with no new
// persisted state.
export function sessionStartedAt(sessionID: string): Date | undefined {
  const zIndex = sessionID.indexOf("Z-");
  const stamp = zIndex >= 0 ? sessionID.slice(0, zIndex + 1) : sessionID;
  const tIndex = stamp.indexOf("T");
  if (tIndex < 0 || !stamp.endsWith("Z")) {
    return undefined;
  }
  const datePart = stamp.slice(0, tIndex);
  const timePart = stamp.slice(tIndex + 1, -1).replace(/-/g, ":");
  const parsed = new Date(`${datePart}T${timePart}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
  if (process.platform === "win32") {
    return processAliveWindows(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function windowsTasklistLine(pid: number): string {
  try {
    const result = spawnSync("cmd.exe", ["/d", "/c", `tasklist /FO CSV /NH /FI "PID eq ${pid}"`], {
      encoding: "buffer",
      windowsHide: true,
      timeout: 5_000,
    });
    return decodeWindowsOutput(result.stdout);
  } catch {
    return "";
  }
}

function processAliveWindows(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Bun/Node may reject signal 0 for other processes.
  }
  const out = windowsTasklistLine(pid).toLowerCase();
  if (out === "" || out.includes("no tasks") || out.includes("no matching")) {
    return false;
  }
  return out.includes(String(pid));
}

function decodeWindowsOutput(buf: Buffer | string | null | undefined): string {
  if (!buf) {
    return "";
  }
  if (typeof buf === "string") {
    return buf;
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

export function randomSecret(): string {
  return randomBytes(24).toString("hex");
}

export function mcpTokenPath(repoRoot: string): string {
  return join(sessionDir(repoRoot), "mcp-token");
}

// The MCP token is pasted into an external agent's config file (Claude Code, Cursor, etc.), so
// unlike the internal RPC token it needs to survive restarts — otherwise every relaunch of devctl
// forces the user to re-copy and re-paste a new token into that external config. Reuse whatever is
// already on disk for this repo; only mint a new one the first time, or if it's ever been deleted.
export function readOrCreateMcpToken(repoRoot: string): string {
  const path = mcpTokenPath(repoRoot);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") {
      return existing;
    }
  }
  const token = randomSecret();
  writeFileSecure(path, token);
  return token;
}
