import { spawn } from "bun";
import { readStamp, type ProcessStamp } from "./liveness.ts";

// PowerShell can need over a second on a cold machine.
const STAMP_QUERY_MS = 5_000;

export type StampCommand = (cmd: string[], env?: Record<string, string>) => Promise<string>;

/**
 * A service's stamp: what tells it from a later process given the same pid.
 * Read the same way when devctl starts a service and when a later daemon
 * recovers it, so the two compare. On Linux it is a few /proc reads; macOS
 * and Windows spawn `ps` or PowerShell, so callers there do not wait on it.
 * Undefined when the start time cannot be read.
 */
export async function serviceStamp(pid: number, platform: NodeJS.Platform = process.platform, run: StampCommand = commandOutput): Promise<ProcessStamp | undefined> {
  if (pid <= 0) {
    return undefined;
  }
  if (platform === "linux") {
    return linuxStamp(pid);
  }
  if (platform === "darwin") {
    // `lstart` prints in the caller's zone and locale; a daemon started with
    // another TZ must read the same text, so both are fixed.
    const fixed = { TZ: "UTC", LC_ALL: "C" };
    const [lstart, boot] = await Promise.all([
      run(["ps", "-o", "lstart=", "-p", String(pid)], fixed),
      run(["sysctl", "-n", "kern.boottime"], fixed),
    ]);
    return lstart === "" ? undefined : { lstart, bootId: boot === "" ? undefined : boot };
  }
  if (platform === "win32") {
    // A UTC FILETIME, in 100 ns ticks: no zone, and no two processes share one.
    const lstart = await run(["powershell.exe", "-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`]);
    return /^\d+$/.test(lstart) ? { lstart } : undefined;
  }
  return undefined;
}

/** The Linux stamp, read synchronously. Undefined elsewhere, or when /proc has no start time. */
export function linuxStamp(pid: number): ProcessStamp | undefined {
  if (process.platform !== "linux" || pid <= 0) {
    return undefined;
  }
  const stamp = readStamp(pid);
  return stamp.startTicks === undefined ? undefined : stamp;
}

async function commandOutput(cmd: string[], env?: Record<string, string>): Promise<string> {
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: "ignore", env: env === undefined ? undefined : { ...process.env, ...env } });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, STAMP_QUERY_MS);
    try {
      const text = await new Response(proc.stdout).text();
      return (await proc.exited) === 0 ? text.trim() : "";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}
