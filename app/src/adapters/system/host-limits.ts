import { readFileSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import type { HostLimits } from "../../ports/host-limits.ts";

const CGROUP_MOUNT = "/sys/fs/cgroup";
// cgroup v1 reports "no limit" as a huge page-aligned number rather than "max".
const UNLIMITED_BYTES = 1e15;

export function readHostLimits(path = "."): HostLimits {
  const memory = readMemoryLimit();
  const disk = readDisk(path);
  const pid1 = readPid1();
  return {
    memoryBytes: memory.limit,
    memoryUsedBytes: memory.used,
    pidsMax: readPidsMax(),
    freeDiskBytes: disk.free,
    totalDiskBytes: disk.total,
    nonReapingPid1: pid1.nonReaping,
    pid1Command: pid1.command,
  };
}

export function readPid1(): { command: string; nonReaping: boolean } {
  if (process.platform !== "linux") {
    return { command: "", nonReaping: false };
  }
  let command = "";
  try {
    command = readFileSync("/proc/1/cmdline", "utf8").replace(/\0/g, " ").trim();
  } catch {
    command = "";
  }
  const base = command.split(" ")[0] ?? "";
  const name = base.split("/").pop() ?? "";
  const nonReaping = name === "sleep" || name === "tail" || name === "pause" || name === "cat";
  return { command, nonReaping };
}

// With no cgroup limit there is no container working set: the memory guard
// then compares this process's RSS with host memory.
function readMemoryLimit(): { limit: number; used?: number } {
  return cgroupMemory(CGROUP_MOUNT, readText("/proc/self/cgroup")) ?? { limit: totalmem() };
}

/**
 * The binding cgroup memory limit and that cgroup's working set: usage less
 * inactive file cache, as `docker stats` reports it, so reclaimable page cache
 * from the spool and session files does not count. Every level from this
 * process's cgroup up to the mount root is read, because a parent's limit
 * applies too, and the level closest to its limit wins. Undefined when no
 * level has a limit.
 */
export function cgroupMemory(mount: string, procSelfCgroup: string | undefined): { limit: number; used: number } | undefined {
  let binding: { limit: number; used: number } | undefined;
  for (const dir of cgroupLevels(mount, procSelfCgroup)) {
    const level = cgroupLevelMemory(dir);
    if (level !== undefined && (binding === undefined || level.used / level.limit > binding.used / binding.limit)) {
      binding = level;
    }
  }
  return binding;
}

function cgroupLevels(mount: string, procSelfCgroup: string | undefined): string[] {
  const own = procSelfCgroup === undefined ? undefined : cgroupDirFromProc(procSelfCgroup, mount);
  const levels: string[] = [];
  for (let dir = own ?? mount; ; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    levels.push(dir);
    if (dir.length <= mount.length || !dir.startsWith(`${mount}/`)) {
      break;
    }
  }
  // cgroup v1 keeps memory in its own hierarchy; a container sees its cgroup at that root.
  levels.push(cgroupPath(mount, "memory"));
  return levels;
}

function cgroupLevelMemory(dir: string): { limit: number; used: number } | undefined {
  const v2 = readText(cgroupPath(dir, "memory.max"));
  if (v2 !== undefined) {
    const limit = parseLimit(v2);
    const usage = readNumber(cgroupPath(dir, "memory.current"));
    return limit === undefined ? undefined : { limit, used: workingSetBytes(usage, readText(cgroupPath(dir, "memory.stat")), "inactive_file") };
  }
  const v1 = readText(cgroupPath(dir, "memory.limit_in_bytes"));
  const limit = v1 === undefined ? undefined : parseLimit(v1);
  const usage = readNumber(cgroupPath(dir, "memory.usage_in_bytes"));
  return limit === undefined ? undefined : { limit, used: workingSetBytes(usage, readText(cgroupPath(dir, "memory.stat")), "total_inactive_file") };
}

/** Usage less inactive file cache, as `docker stats` computes it. A stat read that does not fit under usage leaves usage. */
export function workingSetBytes(usage: number, memoryStat: string | undefined, inactiveKey: string): number {
  const inactive = statValue(memoryStat ?? "", inactiveKey);
  return inactive !== undefined && inactive < usage ? usage - inactive : usage;
}

function statValue(stat: string, key: string): number | undefined {
  for (const line of stat.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

function parseLimit(text: string): number | undefined {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 && value < UNLIMITED_BYTES ? value : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readNumber(path: string): number {
  const value = Number(readText(path)?.trim() ?? "");
  return Number.isFinite(value) ? value : 0;
}

function readPidsMax(): number | undefined {
  const dir = readOwnCgroupDir();
  const value = readFirstNumber(cgroupFiles(dir, ["pids.max"], [cgroupPath(CGROUP_MOUNT, "pids.max"), cgroupPath(CGROUP_MOUNT, "pids/pids.max")]));
  return value > 0 && value < UNLIMITED_BYTES ? value : undefined;
}

/** Directory of this process's cgroup, from `/proc/self/cgroup`. */
export function cgroupDirFromProc(text: string, mount = CGROUP_MOUNT): string | undefined {
  const line = text.split("\n").map((row) => row.trim()).find((row) => {
    const parts = row.split(":");
    return parts.length >= 3 && (parts[0] === "0" || parts[1] === "");
  });
  if (line === undefined) {
    return undefined;
  }
  const relative = line.split(":").slice(2).join(":");
  if (relative === "" || relative === "/") {
    return mount;
  }
  const cleaned = relative.startsWith("/") ? relative.slice(1) : relative;
  return cgroupPath(mount, cleaned);
}

/** cgroup paths are always POSIX, including when the test host is Windows. */
function cgroupPath(mount: string, relative: string): string {
  const base = mount.endsWith("/") ? mount.slice(0, -1) : mount;
  return relative === "" ? base : `${base}/${relative}`;
}

function readOwnCgroupDir(): string | undefined {
  const text = readText("/proc/self/cgroup");
  return text === undefined ? undefined : cgroupDirFromProc(text);
}

function cgroupFiles(dir: string | undefined, names: string[], fallback: string[]): string[] {
  const own = dir === undefined ? [] : names.map((name) => cgroupPath(dir, name));
  return [...own, ...fallback];
}

function readFirstNumber(paths: string[]): number {
  for (const path of paths) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text === "max") {
        return 0;
      }
      const parsed = Number(text);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    } catch {
      // try the next cgroup path
    }
  }
  return 0;
}

function readDisk(path: string): { free: number; total: number } {
  if (process.platform === "win32") {
    return { free: 0, total: 0 };
  }
  try {
    const stats = statfsSync(path);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return { free: 0, total: 0 };
  }
}
