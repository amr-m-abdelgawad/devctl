// Lifetime counters for dashboard KPIs. Tables still show the daemon's
// bounded rings (last 100 requests, last 200 log rows); totals must keep
// growing after those rings fill.

export type RingCounter = {
  readonly seen: number;
  readonly ids: ReadonlySet<string>;
};

export function emptyRingCounter(): RingCounter {
  return { seen: 0, ids: new Set() };
}

/** Count ids that appear in this poll and were not in the previous ring. */
export function advanceRingCounter(state: RingCounter, ids: readonly string[]): RingCounter {
  const next = new Set<string>();
  let added = 0;
  for (const id of ids) {
    if (id !== "") {
      next.add(id);
      if (!state.ids.has(id)) {
        added += 1;
      }
    }
  }
  return { seen: state.seen + added, ids: next };
}

export function lifetimeTotal(...values: Array<number | undefined>): number {
  let best = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > best) {
      best = value;
    }
  }
  return best;
}

export function logLifetime(logs?: {
  total: number;
  errors: number;
  seen?: number;
  seenErrors?: number;
}): { total: number; errors: number } {
  if (!logs) {
    return { total: 0, errors: 0 };
  }
  return {
    total: typeof logs.seen === "number" ? logs.seen : logs.total,
    errors: typeof logs.seenErrors === "number" ? logs.seenErrors : logs.errors,
  };
}
