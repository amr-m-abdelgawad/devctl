import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type ProcState = "alive" | "zombie" | "dead";

const PPID_INDEX = 1;
const PGRP_INDEX = 2;
const STARTTIME_INDEX = 19;

/** State character immediately after the comm field's closing paren. */
export function parseProcStatState(stat: string): string | undefined {
  const end = stat.lastIndexOf(")");
  if (end < 0 || end + 2 >= stat.length) {
    return undefined;
  }
  const state = stat.charAt(end + 2);
  return state === " " || state === "" ? undefined : state;
}

export function isLiveProcState(state: string | undefined): boolean {
  return state !== undefined && state !== "Z" && state !== "X" && state !== "x";
}

export function procStateKind(state: string | undefined, exists: boolean): ProcState {
  if (!exists || state === undefined) {
    return state === "Z" ? "zombie" : "dead";
  }
  if (state === "Z") {
    return "zombie";
  }
  if (!isLiveProcState(state)) {
    return "dead";
  }
  return "alive";
}

export function parseProcStatFields(stat: string): string[] {
  const end = stat.lastIndexOf(")");
  if (end < 0) {
    return [];
  }
  return stat.slice(end + 2).trim().split(/\s+/);
}

export function parseProcStartTicks(stat: string): string | undefined {
  const fields = parseProcStatFields(stat);
  return fields[STARTTIME_INDEX];
}

export function parseProcPgid(stat: string): number | undefined {
  const fields = parseProcStatFields(stat);
  const pgid = Number(fields[PGRP_INDEX]);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
}

export function parseProcPpid(stat: string): number | undefined {
  const fields = parseProcStatFields(stat);
  const ppid = Number(fields[PPID_INDEX]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

export function readProcStat(pid: number): string | undefined {
  if (pid <= 0 || process.platform === "win32") {
    return undefined;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
}

export function processState(pid: number): ProcState {
  if (pid <= 0) {
    return "dead";
  }
  const stat = readProcStat(pid);
  if (stat !== undefined) {
    return procStateKind(parseProcStatState(stat), true);
  }
  if (process.platform === "win32") {
    return processAliveWindows(pid) ? "alive" : "dead";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch {
    return "dead";
  }
}

export type ProcessStamp = {
  startTicks?: string;
  bootId?: string;
  pidNs?: string;
  lstart?: string;
};

// A process's own stamp never changes, and reading it is slow where it
// spawns: `ps` on macOS, PowerShell on Windows (a third of a second or more).
let selfStamp: ProcessStamp | undefined;

export function readSelfStamp(): ProcessStamp {
  selfStamp ??= readStamp(process.pid);
  return { ...selfStamp };
}

/**
 * For a worker thread: the stamp of its process as the main thread already
 * read it, so the worker does not read it a second time.
 */
export function rememberSelfStamp(stamp: ProcessStamp): void {
  selfStamp ??= { ...stamp };
}

export function readStamp(pid: number): ProcessStamp {
  const stamp: ProcessStamp = {};
  const stat = readProcStat(pid);
  if (stat !== undefined) {
    stamp.startTicks = parseProcStartTicks(stat);
  }
  if (process.platform === "linux") {
    try {
      stamp.bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      stamp.bootId = undefined;
    }
    try {
      // A symlink to `pid:[inode]`; reading through it fails with EINVAL.
      stamp.pidNs = readlinkSync(`/proc/${pid}/ns/pid`);
    } catch {
      // another user's process, or /proc mounted without it: compare the other fields
    }
  }
  if (process.platform === "darwin") {
    stamp.bootId = darwinBootTime();
    stamp.lstart = foreignStart(pid, ["ps", "-o", "lstart=", "-p", String(pid)]);
  }
  if (process.platform === "win32") {
    stamp.lstart = foreignStart(pid, ["powershell.exe", "-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`]);
  }
  return stamp;
}

let cachedDarwinBoot: string | undefined;

function darwinBootTime(): string | undefined {
  if (cachedDarwinBoot !== undefined) {
    return cachedDarwinBoot;
  }
  cachedDarwinBoot = commandText(["sysctl", "-n", "kern.boottime"]);
  return cachedDarwinBoot;
}

function foreignStart(pid: number, cmd: string[]): string | undefined {
  if (pid <= 0) {
    return undefined;
  }
  return commandText(cmd);
}

/** The pid's arguments, or undefined when they cannot be read. */
function processCommandLine(pid: number): string[] | undefined {
  if (pid <= 0) {
    return undefined;
  }
  if (process.platform === "linux") {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args.at(-1) === "") {
        args.pop();
      }
      return args.length > 0 ? args : undefined;
    } catch {
      return undefined;
    }
  }
  // Both join argv with spaces, so this split only finds whole arguments
  // that have none, such as `_supervisor`. A cold PowerShell plus a CIM
  // query can take seconds, and a timeout would leave a stale lock in place.
  const text = process.platform === "win32"
    ? commandText(["powershell.exe", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], WINDOWS_QUERY_MS)
    : commandText(["ps", "-ww", "-o", "command=", "-p", String(pid)]);
  return text?.split(/\s+/);
}

const WINDOWS_QUERY_MS = 5_000;

/**
 * Whether the pid runs the daemon subcommand every devctl has spawned
 * (supervisorSpawnCommand). Undefined when its command line is unreadable.
 */
export function isDevctlSupervisor(pid: number): boolean | undefined {
  return processCommandLine(pid)?.includes("_supervisor");
}

function commandText(cmd: string[], timeoutMs = 1_000): string | undefined {
  const bin = cmd[0];
  if (bin === undefined) {
    return undefined;
  }
  try {
    const result = spawnSync(bin, cmd.slice(1), { encoding: "utf8", timeout: timeoutMs });
    const text = result.stdout?.trim();
    return text === "" || text === undefined ? undefined : text;
  } catch {
    return undefined;
  }
}

export function sameStamp(held: ProcessStamp, observed: ProcessStamp): boolean {
  if (held.pidNs !== undefined && observed.pidNs !== undefined && held.pidNs !== observed.pidNs) {
    return false;
  }
  if (held.bootId !== undefined && observed.bootId !== undefined && held.bootId !== observed.bootId) {
    return false;
  }
  if (held.startTicks !== undefined && observed.startTicks !== undefined && held.startTicks !== observed.startTicks) {
    return false;
  }
  if (held.lstart !== undefined && observed.lstart !== undefined && held.lstart !== observed.lstart) {
    return false;
  }
  return true;
}

/** Live (not zombie) members of `pgid`, excluding nothing — callers filter leaders. */
export function livePidsInGroup(pgid: number): number[] {
  if (process.platform !== "linux" || pgid <= 0) {
    return [];
  }
  const live: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    if (/^\d+$/.test(name)) {
      const pid = Number(name);
      const stat = readProcStat(pid);
      const sameGroup = stat !== undefined && parseProcPgid(stat) === pgid;
      if (sameGroup && stat !== undefined && procStateKind(parseProcStatState(stat), true) === "alive") {
        live.push(pid);
      }
    }
  }
  return live;
}

export function groupHasLiveMembers(leaderPid: number): boolean | undefined {
  const stat = readProcStat(leaderPid);
  if (stat === undefined) {
    return undefined;
  }
  const pgid = parseProcPgid(stat);
  if (pgid === undefined) {
    return undefined;
  }
  return livePidsInGroup(pgid).length > 0;
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
    // Bun may reject signal 0 for other processes.
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
