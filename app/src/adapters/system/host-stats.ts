import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { spawnSync } from "node:child_process";

const BYTES_PER_KB = 1024;
const LEFTOVER_CACHE_MS = 2000;
const VM_STAT_PAGE = /page size of (\d+) bytes/i;

export type HostMemory = {
  totalKB: number;
  unusedKB: number;
  leftoverKB: number;
};

let leftoverCache: { at: number; leftoverKB: number } | undefined;

export function parseLinuxMeminfo(text: string): number | undefined {
  const match = text.match(/^MemAvailable:\s+(\d+)/m);
  if (!match) {
    return undefined;
  }
  const kb = Number(match[1]);
  return Number.isFinite(kb) && kb >= 0 ? kb : undefined;
}

export function parseDarwinVmStat(text: string): number | undefined {
  const pageMatch = text.match(VM_STAT_PAGE);
  const pageSize = pageMatch ? Number(pageMatch[1]) : 0;
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return undefined;
  }
  const pages = vmStatPages(text, "free") + vmStatPages(text, "inactive") + vmStatPages(text, "speculative") + vmStatPages(text, "purgeable");
  return Math.round((pages * pageSize) / BYTES_PER_KB);
}

function vmStatPages(text: string, kind: string): number {
  const match = text.match(new RegExp(`Pages ${kind}:\\s+(\\d+)`, "i"));
  const n = match ? Number(match[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function leftoverFromHost(): number | undefined {
  if (process.platform === "linux") {
    try {
      return parseLinuxMeminfo(readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const now = Date.now();
    if (leftoverCache && now - leftoverCache.at < LEFTOVER_CACHE_MS) {
      return leftoverCache.leftoverKB;
    }
    const out = spawnSync("vm_stat", { encoding: "utf8" });
    if (out.status !== 0 || !out.stdout) {
      return leftoverCache?.leftoverKB;
    }
    const leftoverKB = parseDarwinVmStat(out.stdout);
    if (leftoverKB === undefined) {
      return leftoverCache?.leftoverKB;
    }
    leftoverCache = { at: now, leftoverKB };
    return leftoverKB;
  }
  return undefined;
}

export function readHostMemory(): HostMemory {
  const totalKB = Math.max(0, Math.round(totalmem() / BYTES_PER_KB));
  const unusedKB = Math.max(0, Math.round(freemem() / BYTES_PER_KB));
  const leftoverKB = Math.max(0, Math.min(totalKB, leftoverFromHost() ?? unusedKB));
  return { totalKB, unusedKB, leftoverKB };
}
