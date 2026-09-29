import { readFileSync, statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import type { HostLimits } from "../../ports/host-limits.ts";

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

function readMemoryLimit(): { limit: number; used?: number } {
  const cgroup = readCgroupMemory();
  if (cgroup.limit > 0) {
    return cgroup;
  }
  return { limit: totalmem(), used: totalmem() - freemem() };
}

function readCgroupMemory(): { limit: number; used?: number } {
  const dir = readOwnCgroupDir();
  const limit = readFirstNumber(cgroupFiles(dir, ["memory.max", "memory.limit_in_bytes"], ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]));
  const used = readFirstNumber(cgroupFiles(dir, ["memory.current", "memory.usage_in_bytes"], ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]));
  if (limit <= 0 || limit > 1e15) {
    return { limit: 0, used: used > 0 ? used : undefined };
  }
  return { limit, used: used > 0 ? used : undefined };
}

function readPidsMax(): number | undefined {
  const dir = readOwnCgroupDir();
  const value = readFirstNumber(cgroupFiles(dir, ["pids.max"], ["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"]));
  return value > 0 && value < 1e15 ? value : undefined;
}

/** Directory of this process's cgroup, from `/proc/self/cgroup`. */
export function cgroupDirFromProc(text: string, mount = "/sys/fs/cgroup"): string | undefined {
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
  return join(mount, cleaned);
}

function readOwnCgroupDir(): string | undefined {
  try {
    return cgroupDirFromProc(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return undefined;
  }
}

function cgroupFiles(dir: string | undefined, names: string[], fallback: string[]): string[] {
  const own = dir === undefined ? [] : names.map((name) => join(dir, name));
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
