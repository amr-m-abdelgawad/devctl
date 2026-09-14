export type SlidingWindowHotspot = {
  key: string;
  count: number;
};

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  tryAcquire(key: string): boolean {
    const times = this.prune(key);
    if (times.length >= this.limit) {
      return false;
    }
    times.push(this.now());
    this.hits.set(key, times);
    return true;
  }

  count(key: string): number {
    return this.prune(key).length;
  }

  hottest(): SlidingWindowHotspot | undefined {
    let best: SlidingWindowHotspot | undefined;
    for (const key of [...this.hits.keys()]) {
      const n = this.prune(key).length;
      if (n > 0 && (!best || n > best.count)) {
        best = { key, count: n };
      }
    }
    return best;
  }

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const times = (this.hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    if (times.length === 0) {
      this.hits.delete(key);
    } else {
      this.hits.set(key, times);
    }
    return times;
  }
}
