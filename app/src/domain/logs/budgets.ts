/** Byte budgets for the log pipeline, persistence, and capture stores. */

const KIB = 1024;
const MIB = 1024 * KIB;

const RING_MEMORY_FRACTION = 0.08;
const RING_MEMORY_MIN_BYTES = 96 * MIB;
const RING_MEMORY_MAX_BYTES = 384 * MIB;

const GIB = 1024 * MIB;
const DEFAULT_CAPTURE_STORE_BYTES = 128 * MIB;

/** Default cap for one session file and for the not-yet-parsed spool. */
export const DEFAULT_LOG_CAP_BYTES = GIB;
/** Default cap across closed session directories. */
export const DEFAULT_LOG_TOTAL_BYTES = 2 * GIB;
const DISK_FREE_FRACTION = 0.05;

export const CREDIT_PER_STREAM_BYTES = 4 * MIB;
export const CREDIT_TOTAL_BYTES = 16 * MIB;
export const SPILL_PER_STREAM_BYTES = MIB;
export const SPILL_TOTAL_BYTES = 8 * MIB;
export const SPLIT_MAX_BYTES = 48 * KIB;
export const PROCESS_SLICE_MS = 8;
export const HISTORY_SCAN_BYTES = 32 * MIB;
export const HISTORY_SCAN_MS = 50;
export const RUN_ONCE_DRAIN_GRACE_MS = 200;
export const COALESCE_BYTES = 256 * KIB;
export const COALESCE_MS = 5;

export function autoRingBytes(hostMemoryBytes: number): number {
  if (!Number.isFinite(hostMemoryBytes) || hostMemoryBytes <= 0) {
    return RING_MEMORY_MIN_BYTES;
  }
  const raw = Math.floor(hostMemoryBytes * RING_MEMORY_FRACTION);
  return Math.min(RING_MEMORY_MAX_BYTES, Math.max(RING_MEMORY_MIN_BYTES, raw));
}

export function captureStoreBytes(configured: number): number {
  return configured > 0 ? configured : DEFAULT_CAPTURE_STORE_BYTES;
}

/** `0` selects the documented default. A positive value is the configured cap. */
export function configuredByteCap(configured: number, fallback: number): number {
  return configured > 0 ? configured : fallback;
}

/** True when free space is above the larger of 1 GiB and 5% of the volume. */
export function diskReserveBytes(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return DEFAULT_LOG_CAP_BYTES;
  }
  return Math.max(DEFAULT_LOG_CAP_BYTES, Math.floor(totalBytes * DISK_FREE_FRACTION));
}
