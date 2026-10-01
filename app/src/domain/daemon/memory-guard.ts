/** Shrink the ring at 75% of the cgroup limit, and shed capture bodies at 90%. */

export const MEMORY_SHRINK_RATIO = 0.75;
export const MEMORY_SHED_RATIO = 0.9;

export type MemoryPressure = "ok" | "shrink" | "shed";

export function memoryPressure(rssBytes: number, limitBytes: number): MemoryPressure {
  if (!Number.isFinite(rssBytes) || !Number.isFinite(limitBytes) || rssBytes <= 0 || limitBytes <= 0) {
    return "ok";
  }
  const ratio = rssBytes / limitBytes;
  if (ratio >= MEMORY_SHED_RATIO) {
    return "shed";
  }
  if (ratio >= MEMORY_SHRINK_RATIO) {
    return "shrink";
  }
  return "ok";
}

/**
 * What the guard compares: the container's working set with its cgroup limit,
 * or, with no cgroup limit, this process's RSS with host memory.
 */
export function memoryGuardUsage(limits: { readonly memoryBytes: number; readonly memoryUsedBytes?: number }, rssBytes: number): { usedBytes: number; limitBytes: number } {
  return { usedBytes: limits.memoryUsedBytes ?? rssBytes, limitBytes: limits.memoryBytes };
}

const RING_FLOOR_BYTES = 8 * 1024 * 1024;

/**
 * The log ring's budget at each level: full when ok, half under shrink, and a
 * quarter while shedding, since shedding no longer pauses ingest.
 */
export function ringBudgetFor(pressure: MemoryPressure, fullBytes: number): number {
  if (pressure === "ok") {
    return fullBytes;
  }
  const share = Math.floor(fullBytes / (pressure === "shed" ? 4 : 2));
  return Math.min(fullBytes, Math.max(RING_FLOOR_BYTES, share));
}

/** Below this, a shrunk ring is restored. Shrink itself drops RSS back under 75%. */
export const MEMORY_RECOVER_RATIO = 0.6;

/**
 * Holds a shrink after RSS falls, so freeing the ring does not immediately
 * restore it and climb back over 75%. Shed stays until usage is under 75%,
 * because entering shed also shrinks the ring and that dip would otherwise
 * cancel the shed on the next tick.
 */
export function nextMemoryGuard(previous: MemoryPressure, ratio: number): MemoryPressure {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return previous;
  }
  if (ratio >= MEMORY_SHED_RATIO) {
    return "shed";
  }
  if (previous === "shed" && ratio >= MEMORY_SHRINK_RATIO) {
    return "shed";
  }
  if (ratio >= MEMORY_SHRINK_RATIO) {
    return "shrink";
  }
  if (previous !== "ok" && ratio >= MEMORY_RECOVER_RATIO) {
    return "shrink";
  }
  return "ok";
}
