// Rate samples for the overview tiles and Graph charts. Request rates count
// timestamps in the recent proxy buffer. Log rates difference the lifetime
// ingest counters, because the overview poll only loads a short ERROR page.

const HTTP_CLIENT_ERROR = 400;

export type CounterSample = {
  readonly t: number;
  readonly value: number;
};

export function requestIsFailure(row: { status: number; error?: string }): boolean {
  return row.status >= HTTP_CLIENT_ERROR || Boolean(row.error);
}

/** Events per second among timestamps that fall inside the lookback. */
export function rateInWindow(timestamps: readonly string[], nowMs: number, lookbackMs: number): number {
  const cutoff = nowMs - lookbackMs;
  const seconds = lookbackMs / 1000;
  let count = 0;
  for (const stamp of timestamps) {
    const ts = Date.parse(stamp);
    if (!Number.isNaN(ts) && ts >= cutoff) {
      count += 1;
    }
  }
  return count / seconds;
}

/**
 * Change per second of a monotonic counter over the lookback.
 * Uses the newest sample at or before the cutoff, or the oldest sample while
 * the history is still shorter than the window. A reset (current below the
 * baseline) reports zero.
 */
export function counterWindowRate(
  history: readonly CounterSample[],
  nowSec: number,
  current: number,
  lookbackSec: number,
): number {
  const baseline = baselineSample(history, nowSec - lookbackSec);
  if (!baseline) {
    return 0;
  }
  const elapsed = nowSec - baseline.t;
  if (elapsed <= 0) {
    return 0;
  }
  return Math.max(0, current - baseline.value) / elapsed;
}

function baselineSample(history: readonly CounterSample[], cutoff: number): CounterSample | undefined {
  let baseline = history[0];
  if (!baseline) {
    return undefined;
  }
  for (const sample of history) {
    if (sample.t <= cutoff) {
      baseline = sample;
    }
  }
  return baseline;
}
