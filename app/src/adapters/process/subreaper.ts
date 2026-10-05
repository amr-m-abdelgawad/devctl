import { readdirSync, readFileSync } from "node:fs";
import { parseProcPgid, parseProcPpid, parseProcStartTicks, parseProcStatState, readProcStat } from "./liveness.ts";

const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;
// A dead child is reaped once this many scans in a row have seen it. Bun
// collects a child it spawned within a turn of its event loop, and needs that
// child's exit status, so only one that stays dead across scans is taken.
const SIGHTINGS_TO_REAP = 3;
// With nothing dead in sight, a scan runs every this many ticks.
const IDLE_TICKS = 5;
// A pid that was a service's own is left to Bun for this many ticks after the service is gone.
const LEADER_GRACE_TICKS = 60;

export type ReaperHost = {
  /** This process's pid. */
  readonly self: number;
  /** Pids that may be children of this process. */
  children(): number[];
  /** `/proc/<pid>/stat`, or undefined once the process is gone. */
  stat(pid: number): string | undefined;
  /** Collects a dead child without waiting. True when it was collected. */
  reap(pid: number): boolean;
};

/**
 * Collects the orphans of this daemon's services. A child subreaper is
 * handed every descendant whose own parent died first. A stop or restart of
 * a shell-wrapped service leaves exactly that: the shell dies before it
 * collects its child. PID 1 would otherwise get the child, and a PID 1 such
 * as `sleep infinity` never collects it, so each restart left one zombie.
 *
 * Children that Bun spawned are Bun's to collect: it reads their exit
 * status. So a service's own pid is never touched, and any other dead child
 * is taken only once it has stayed dead for three scans, by which time Bun
 * would have collected one of its own. A dead member of a running service's
 * group that is not the service itself was never spawned here, and is taken
 * at once.
 */
export class OrphanReaper {
  private readonly watched = new Map<number, { start: string; sightings: number }>();
  private readonly leaders = new Map<number, number>();
  private ticks = 0;
  private sinceScan = IDLE_TICKS;
  private busy = false;

  constructor(private readonly host: ReaperHost) {}

  /** Called once a second with the running services' own pids. Returns how many children it collected. */
  tick(services: readonly number[]): number {
    this.ticks += 1;
    for (const pid of services) {
      this.leaders.set(pid, this.ticks);
    }
    this.sinceScan += 1;
    if (!this.busy && this.sinceScan < IDLE_TICKS) {
      return 0;
    }
    this.sinceScan = 0;
    for (const [pid, seenAt] of this.leaders) {
      if (this.ticks - seenAt > LEADER_GRACE_TICKS) {
        this.leaders.delete(pid);
      }
    }
    const running = new Set(services);
    const dead = new Set<number>();
    let reaped = 0;
    for (const pid of this.host.children()) {
      const stat = this.host.stat(pid);
      if (stat === undefined || parseProcStatState(stat) !== "Z" || parseProcPpid(stat) !== this.host.self || this.leaders.has(pid)) {
        continue;
      }
      dead.add(pid);
      const start = parseProcStartTicks(stat) ?? "";
      const before = this.watched.get(pid);
      const sightings = before !== undefined && before.start === start ? before.sightings + 1 : 1;
      const group = parseProcPgid(stat);
      const inRunningGroup = group !== undefined && group !== pid && running.has(group);
      if (inRunningGroup || sightings >= SIGHTINGS_TO_REAP) {
        this.watched.delete(pid);
        reaped += this.host.reap(pid) ? 1 : 0;
      } else {
        this.watched.set(pid, { start, sightings });
      }
    }
    for (const pid of this.watched.keys()) {
      if (!dead.has(pid)) {
        // Collected by Bun, or by this pid's next owner.
        this.watched.delete(pid);
      }
    }
    this.busy = dead.size > 0;
    return reaped;
  }
}

/**
 * Makes this process a child subreaper and returns the reaper for it.
 * Undefined where that cannot be done: not Linux, or no glibc to call into
 * (musl), in which case orphans go to PID 1 as before.
 */
export async function startOrphanReaper(): Promise<OrphanReaper | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  const libc = await loadLibc();
  if (libc === undefined || libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
    return undefined;
  }
  return new OrphanReaper({
    self: process.pid,
    children: () => childrenOf(process.pid),
    stat: readProcStat,
    reap: (pid) => libc.waitpid(pid, 0, WNOHANG) > 0,
  });
}

/** Whether this system lets the daemon reap for a PID 1 that does not: Linux with a glibc to call into. */
export async function orphanReaperAvailable(): Promise<boolean> {
  return process.platform === "linux" && (await loadLibc()) !== undefined;
}

type Libc = {
  prctl(option: number, arg2: number, arg3: number, arg4: number, arg5: number): number;
  waitpid(pid: number, status: number, options: number): number;
};

async function loadLibc(): Promise<Libc | undefined> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
      waitpid: {
        args: [FFIType.i32, FFIType.u64, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return {
      prctl: (option, arg2, arg3, arg4, arg5) => libc.symbols.prctl(option, arg2, arg3, arg4, arg5),
      waitpid: (pid, status, options) => libc.symbols.waitpid(pid, status, options),
    };
  } catch {
    return undefined;
  }
}

// False once the kernel turns out not to list a thread's children.
let childrenListed = true;

/**
 * The pids whose parent may be `self`. The kernel lists each thread's
 * children, adopted orphans included, in `/proc/<pid>/task/<tid>/children`:
 * a handful of small reads. Without that file every pid is returned and the
 * caller tells by each one's parent.
 */
function childrenOf(self: number): number[] {
  if (childrenListed) {
    try {
      // The main thread's list is there whenever the kernel keeps these lists.
      readFileSync(`/proc/${self}/task/${self}/children`, "utf8");
    } catch {
      childrenListed = false;
    }
  }
  const pids: number[] = [];
  if (!childrenListed) {
    for (const name of listDir("/proc")) {
      if (/^\d+$/.test(name)) {
        pids.push(Number(name));
      }
    }
    return pids;
  }
  for (const tid of listDir(`/proc/${self}/task`)) {
    let listed = "";
    try {
      listed = readFileSync(`/proc/${self}/task/${tid}/children`, "utf8");
    } catch {
      // the thread ended
    }
    for (const part of listed.split(" ")) {
      const pid = Number(part);
      if (pid > 0) {
        pids.push(pid);
      }
    }
  }
  return pids;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
