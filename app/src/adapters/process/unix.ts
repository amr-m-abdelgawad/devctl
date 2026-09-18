import { spawn } from "bun";
import { readFile, readlink } from "node:fs/promises";
import { processAlive } from "../storage/storage.ts";

// /proc on Linux exposes process identity and memory without `ps`/`lsof`, which
// a minimal container image (e.g. a uv/python-slim base) often does not ship.
// USER_HZ (clock ticks reported in /proc) and the page size are effectively
// fixed at 100 and 4 KiB on Linux hosts/containers; they only affect a start
// timestamp and an RSS figure, never correctness of anything else.
const PROC_USER_HZ = 100;
const PROC_PAGE_KB = 4;

async function readProcText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function killProcessTreeUnix(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}

export type ProcessIdentity = {
  pid: number;
  command: string;
  cwd: string;
  startTime?: string;
};

// Turn /proc/<pid>/cmdline (NUL-separated argv, often with a trailing NUL) into
// a space-joined command line. Empty for a kernel thread (empty cmdline).
export function parseProcCmdline(text: string): string {
  return text.split("\0").filter((part) => part !== "").join(" ").trim();
}

// The `starttime` field (clock ticks after boot) from /proc/<pid>/stat. Read
// from AFTER the final ')' so a `comm` containing spaces/parens cannot shift the
// offset; starttime is field 22, i.e. index 19 counting state(3) as index 0.
export function parseProcStatStarttimeTicks(text: string): number | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) {
    return undefined;
  }
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ticks = Number(rest[19]);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
}

// The `comm` field (process name) from /proc/<pid>/stat, between the first '('
// and the last ')'. Used as the command for a kernel thread with empty cmdline.
export function parseProcStatComm(text: string): string {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close <= open) {
    return "";
  }
  return text.slice(open + 1, close);
}

// Resident set size in KiB from /proc/<pid>/statm (field 2 is resident pages).
export function parseProcStatmResidentKb(text: string): number | undefined {
  const resident = Number(text.trim().split(/\s+/)[1]);
  return Number.isInteger(resident) && resident >= 0 ? resident * PROC_PAGE_KB : undefined;
}

export function parseProcUptimeSeconds(text: string): number | undefined {
  const token = text.trim().split(/\s+/)[0] ?? "";
  if (token === "") {
    return undefined;
  }
  const seconds = Number(token);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function inspectProcessProc(pid: number, sampledAt: number): Promise<ProcessIdentity | undefined> {
  const stat = await readProcText(`/proc/${pid}/stat`);
  const command = parseProcCmdline(await readProcText(`/proc/${pid}/cmdline`)) || parseProcStatComm(stat);
  if (command === "") {
    return undefined; // fall back to ps/lsof
  }
  let cwd = "";
  try {
    cwd = await readlink(`/proc/${pid}/cwd`);
  } catch {
    cwd = "";
  }
  const ticks = parseProcStatStarttimeTicks(stat);
  const uptime = parseProcUptimeSeconds(await readProcText("/proc/uptime"));
  const startTime = ticks !== undefined && uptime !== undefined
    ? new Date(sampledAt - (uptime - ticks / PROC_USER_HZ) * 1000).toISOString()
    : undefined;
  return { pid, command, cwd, startTime };
}

export async function inspectProcessUnix(pid: number): Promise<ProcessIdentity | undefined> {
  if (!processAlive(pid)) {
    return undefined;
  }
  if (process.platform === "linux") {
    const viaProc = await inspectProcessProc(pid, Date.now());
    if (viaProc !== undefined) {
      return viaProc;
    }
  }
  const command = await captureProcessOutput(["ps", "-p", String(pid), "-o", "command="]);
  // BSD/Linux `ps lstart` has no timezone suffix. Date.parse therefore
  // interprets it in the JS process's TZ, which may differ from the host TZ
  // used by ps (for example a daemon launched with TZ=UTC on a Cairo host).
  // `etime` is an elapsed duration and is timezone-independent.
  const sampledAt = Date.now();
  const elapsed = parseElapsedMillis(await captureProcessOutput(["ps", "-p", String(pid), "-o", "etime="]));
  const cwd = await cwdOf(pid);
  return {
    pid,
    command: command.trim(),
    cwd,
    startTime: elapsed === undefined ? undefined : new Date(sampledAt - elapsed).toISOString(),
  };
}

// ps etime formats: MM:SS, HH:MM:SS, or DD-HH:MM:SS.
export function parseElapsedMillis(text: string): number | undefined {
  const value = text.trim();
  if (value === "") {
    return undefined;
  }
  const dash = value.indexOf("-");
  const daysText = dash >= 0 ? value.slice(0, dash) : "0";
  const clock = dash >= 0 ? value.slice(dash + 1) : value;
  const parts = clock.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return undefined;
  }
  const days = Number(daysText);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  const minutes = Number(parts.length === 3 ? parts[1] : parts[0]);
  const seconds = Number(parts.at(-1));
  if (
    !Number.isInteger(days) || days < 0 ||
    !Number.isInteger(hours) || hours < 0 || hours > 23 ||
    !Number.isInteger(minutes) || minutes < 0 || minutes > 59 ||
    !Number.isInteger(seconds) || seconds < 0 || seconds > 59
  ) {
    return undefined;
  }
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

async function cwdOf(pid: number): Promise<string> {
  const lsof = await captureProcessOutput(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = lsof.split("\n").find((row) => row.startsWith("n"));
  if (line && line.length > 1) {
    return line.slice(1).trim();
  }
  const pwdx = await captureProcessOutput(["pwdx", String(pid)]);
  const idx = pwdx.indexOf(":");
  if (idx >= 0) {
    return pwdx.slice(idx + 1).trim();
  }
  return "";
}

export async function captureProcessOutput(cmd: string[]): Promise<string> {
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    const text = proc.stdout ? await new Response(proc.stdout).text() : "";
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}

export type ResourceSample = { pid: number; cpuPercent: number; memoryKB: number };

export async function sampleResourceUsageUnix(pids: number[]): Promise<Map<number, ResourceSample>> {
  const result = new Map<number, ResourceSample>();
  if (pids.length === 0) {
    return result;
  }
  const out = await captureProcessOutput(["ps", "-o", "pid=,pcpu=,rss=", "-p", pids.join(",")]);
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const [pidStr, cpuStr, rssStr] = trimmed.split(/\s+/);
    const pid = Number(pidStr);
    const cpuPercent = Number(cpuStr);
    const memoryKB = Number(rssStr);
    if (Number.isFinite(pid) && Number.isFinite(cpuPercent) && Number.isFinite(memoryKB)) {
      result.set(pid, { pid, cpuPercent, memoryKB });
    }
  }
  // On Linux, back-fill memory from /proc for any pid `ps` did not report — a
  // minimal container may have no `ps` at all, so this keeps the memory column
  // alive. CPU% still needs `ps` (a single /proc sample cannot reproduce its
  // lifetime average without guessing the clock rate), so it stays 0 here.
  if (process.platform === "linux") {
    for (const pid of pids) {
      if (result.has(pid)) {
        continue;
      }
      const memoryKB = parseProcStatmResidentKb(await readProcText(`/proc/${pid}/statm`));
      if (memoryKB !== undefined) {
        result.set(pid, { pid, cpuPercent: 0, memoryKB });
      }
    }
  }
  return result;
}

export function commandMatches(expected: string[], observed: string): boolean {
  if (expected.length === 0 || observed === "") {
    return false;
  }
  const joined = expected.join(" ");
  if (observed.includes(joined)) {
    return true;
  }
  const first = expected[0] ?? "";
  const base = first.split(/[/\\]/).pop() ?? "";
  if (base !== "" && observed.includes(base)) {
    return true;
  }
  const last = expected[expected.length - 1] ?? "";
  return last !== "" && observed.includes(last);
}
