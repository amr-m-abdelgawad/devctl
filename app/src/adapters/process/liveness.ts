import { readdirSync, readFileSync } from "node:fs";

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
    return "dead";
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

export function readSelfStamp(): ProcessStamp {
  return readStamp(process.pid);
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
      stamp.pidNs = readFileSync(`/proc/${pid}/ns/pid`, "utf8");
    } catch {
      // bind-mounted namespaces may be unreadable; callers fall back to a socket probe
    }
  }
  return stamp;
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
