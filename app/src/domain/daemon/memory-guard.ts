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
