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
  const start = await capture(["ps", "-p", String(pid), "-o", "lstart="]);
  const cwd = await cwdOf(pid);
  return {
    pid,
    command: command.trim(),
    cwd,
    startTime: start.trim() === "" ? undefined : start.trim(),
  };
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

export function commandMatches(expected: string[], observed: string): boolean {
  if (expected.length === 0 || observed === "") {
    return false;
  }
  const joined = expected.join(" ");
  if (observed.includes(joined)) {
    return true;
  }
  const first = expected[0] ?? "";
  const base = first.split("/").pop() ?? "";
  if (base !== "" && observed.includes(base)) {
    return true;
  }
  const last = expected[expected.length - 1] ?? "";
  return last !== "" && observed.includes(last);
}
