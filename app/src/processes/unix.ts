import { spawn } from "bun";
import { processAlive } from "../storage.ts";

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

export async function inspectProcessUnix(pid: number): Promise<ProcessIdentity | undefined> {
  if (!processAlive(pid)) {
    return undefined;
  }
  const command = await capture(["ps", "-p", String(pid), "-o", "command="]);
  // BSD/Linux `ps lstart` has no timezone suffix. Date.parse therefore
  // interprets it in the JS process's TZ, which may differ from the host TZ
  // used by ps (for example a daemon launched with TZ=UTC on a Cairo host).
  // `etime` is an elapsed duration and is timezone-independent.
  const sampledAt = Date.now();
  const elapsed = parseElapsedMillis(await capture(["ps", "-p", String(pid), "-o", "etime="]));
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
  const lsof = await capture(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = lsof.split("\n").find((row) => row.startsWith("n"));
  if (line && line.length > 1) {
    return line.slice(1).trim();
  }
  const pwdx = await capture(["pwdx", String(pid)]);
  const idx = pwdx.indexOf(":");
  if (idx >= 0) {
    return pwdx.slice(idx + 1).trim();
  }
  return "";
}

async function capture(cmd: string[]): Promise<string> {
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
  const out = await capture(["ps", "-o", "pid=,pcpu=,rss=", "-p", pids.join(",")]);
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
