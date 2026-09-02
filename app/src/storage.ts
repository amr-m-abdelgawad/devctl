import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  // Every caller that names the same repository must land in the same state
  // directory, even when one spelling contains redundant separators or is
  // relative. Otherwise the daemon can bind one socket while its client dials
  // another (macOS TMPDIR commonly ends in a separator, which exposed this).
  const canonical = resolve(repoRoot);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const sum = createHash("sha256").update(normalized).digest("hex");
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

// Bootstrap stderr from the detached `_supervisor` process spawned by
// ensureSupervisor() — separate from the service/session logs the running
// supervisor writes once it's up, since a boot failure means those never
// start. Repo-specific (not shared across repos) so concurrent supervisors
// don't interleave their startup errors in one file.
export function bootstrapLogPath(repoRoot: string): string {
  return join(sessionDir(repoRoot), "bootstrap.log");
}

export const BOOTSTRAP_LOG_HISTORY = 5;
const BOOTSTRAP_LOG_PREFIX = "bootstrap-";

// ensureSupervisor() opens bootstrapLogPath() with Bun.file() as the new
// child's stderr sink, which truncates on open — so without this, every
// failed boot attempt silently erases the previous one's stderr, leaving
// only the latest when a user goes looking for why the daemon won't start.
// Call this right before spawning: it moves whatever is currently at
// bootstrapLogPath() aside under its own bounded, timestamped rotation —
// entirely separate from how service logs are persisted/pruned
// (LogManager's per-session directories) — so the next Bun.file() open
// starts fresh while recent history survives.
export function rotateBootstrapLog(repoRoot: string): void {
  const current = bootstrapLogPath(repoRoot);
  if (!existsSync(current)) {
    return;
  }
  const dir = sessionDir(repoRoot);
  const rotated = join(dir, `${BOOTSTRAP_LOG_PREFIX}${newSessionID()}.log`);
  try {
    renameSync(current, rotated);
  } catch {
    return;
  }
  pruneBootstrapLogs(dir);
}

function pruneBootstrapLogs(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(BOOTSTRAP_LOG_PREFIX) && name.endsWith(".log"));
  } catch {
    return;
  }
  // Ordered by actual mtime rather than by name: newSessionID()'s stamp is
  // only second-resolution, so several rotations within one second (a fast
  // crash loop) would otherwise tie-break on their random suffix alone and
  // risk pruning a newer attempt instead of an older one.
  const files = names
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { path: string; mtime: number } => entry !== undefined)
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = BOOTSTRAP_LOG_HISTORY; i < files.length; i++) {
    try {
      unlinkSync(files[i]!.path);
    } catch {
      // best-effort cleanup; a failed unlink here isn't worth surfacing
    }
  }
}

export function writeFileSecure(path: string, data: string | Buffer): void {
  ensureDir(dirname(path));
  // Write-then-rename instead of an in-place write so a reader (or a crash
  // mid-write) never observes a truncated/partial file — rename() is atomic
  // on the same filesystem on both POSIX and Windows. This matters most for
  // state.json: it's the file a future `devctl start`/`status` reads back to
  // adopt processes left running after a detach-quit.
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, data, { mode: FILE_PERM });
  renameSync(tmp, path);
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
  return readPersistedStateFile(statePath(repoRoot));
}

// Shared with daemon.ts's state-directory scan, which reads state.json
// files by their on-disk path directly rather than deriving it from a
// repo_root it doesn't have yet — that's the whole point of the scan.
export function readPersistedStateFile(path: string): PersistedState | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedState & { services?: Record<string, unknown> };
    if (Array.isArray(parsed.processes) && typeof parsed.repo_root === "string") {
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
