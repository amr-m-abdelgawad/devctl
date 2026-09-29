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
