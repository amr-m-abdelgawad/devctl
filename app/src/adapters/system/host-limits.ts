import { readFileSync, statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
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
  const limit = readFirstNumber(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  const used = readFirstNumber(["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
  if (limit <= 0 || limit > 1e15) {
    return { limit: 0, used: used > 0 ? used : undefined };
  }
  return { limit, used: used > 0 ? used : undefined };
}

function readPidsMax(): number | undefined {
  const value = readFirstNumber(["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"]);
  return value > 0 && value < 1e15 ? value : undefined;
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
