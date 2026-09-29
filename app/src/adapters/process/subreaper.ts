import { readdirSync, readFileSync } from "node:fs";
import { parseProcPgid, parseProcPpid, parseProcStatState } from "./liveness.ts";

const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;

/**
 * Ask Linux to make this process a child subreaper. Only compiled glibc builds
 * are expected to have libc.so.6; failure leaves reaping to PID 1.
 */
export async function enableChildSubreaper(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    return libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) === 0;
  } catch {
    return false;
  }
}

/**
 * Reaps zombies whose parent is this daemon and whose group is a service
 * group, skipping the group leader. Other children are left alone.
 */
export async function reapOrphanedChildren(servicePids: readonly number[]): Promise<number> {
  if (process.platform !== "linux" || servicePids.length === 0) {
    return 0;
  }
  const groups = new Set(servicePids);
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return 0;
  }
  const zombies: number[] = [];
  for (const name of names) {
    if (/^\d+$/.test(name)) {
      const pid = Number(name);
      const stat = readProcStat(pid);
      const ppid = stat === undefined ? undefined : parseProcPpid(stat);
      const pgid = stat === undefined ? undefined : parseProcPgid(stat);
      const state = stat === undefined ? undefined : parseProcStatState(stat);
      const orphan = ppid !== undefined && pgid !== undefined && state === "Z" && ppid === process.pid && pid !== pgid && groups.has(pgid);
      if (orphan) {
        zombies.push(pid);
      }
    }
  }
  if (zombies.length === 0) {
    return 0;
  }
  const waitpid = await loadWaitpid();
  if (waitpid === undefined) {
    return 0;
  }
  let reaped = 0;
  for (const pid of zombies) {
    if (waitpid(pid, 0, WNOHANG) > 0) {
      reaped += 1;
    }
  }
  return reaped;
}

function readProcStat(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
}

async function loadWaitpid(): Promise<((pid: number, status: number, options: number) => number) | undefined> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      waitpid: {
        args: [FFIType.i32, FFIType.u64, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return (pid, status, options) => libc.symbols.waitpid(pid, status, options);
  } catch {
    return undefined;
  }
}
