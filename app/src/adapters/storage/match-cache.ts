/** Where one stored record's line is in a session's part files. */
export type LineLocation = {
  readonly seq: number;
  readonly part: string;
  readonly offset: number;
  readonly length: number;
};

/** A seq range that has been scanned for one query, and where each match in it is, in seq order. */
export type ScannedRange = {
  readonly lo: number;
  readonly hi: number;
  readonly matches: readonly LineLocation[];
};

const MAX_QUERIES = 8;
// A query matching more than this is paged by scanning instead.
const MAX_MATCHES = 65_536;

/**
 * For each recent query, the seq range already scanned and the lines in it
 * that matched, so a repeated poll reads only those lines instead of the
 * whole range again, and a poll after the window moved scans only the part
 * it has not seen. Bounded by queries kept and matches per query.
 */
export class MatchCache {
  private readonly ranges = new Map<string, ScannedRange>();

  /** Forgets every range: what was scanned no longer says which records match. */
  clear(): void {
    this.ranges.clear();
  }

  /** The range cached for `key`, less anything below `lo`, now the most recent. */
  get(key: string, lo: number): ScannedRange | undefined {
    const range = this.ranges.get(key);
    if (range === undefined) {
      return undefined;
    }
    this.ranges.delete(key);
    if (range.hi <= lo) {
      return undefined;
    }
    const kept = range.lo >= lo ? range : { lo, hi: range.hi, matches: range.matches.slice(firstAtOrAbove(range.matches, lo)) };
    this.ranges.set(key, kept);
    return kept;
  }

  /**
   * Folds a walk's contiguous scanned run into the cached range when the
   * two touch, the run's matches winning inside it; otherwise the run
   * replaces what was cached.
   */
  remember(key: string, run: ScannedRange): void {
    const cached = this.ranges.get(key);
    this.ranges.delete(key);
    const touching = cached !== undefined && run.lo <= cached.hi && run.hi >= cached.lo;
    const merged: ScannedRange = touching
      ? {
          lo: Math.min(cached.lo, run.lo),
          hi: Math.max(cached.hi, run.hi),
          matches: [
            ...cached.matches.slice(0, firstAtOrAbove(cached.matches, run.lo)),
            ...run.matches,
            ...cached.matches.slice(firstAtOrAbove(cached.matches, run.hi)),
          ],
        }
      : run;
    if (merged.matches.length > MAX_MATCHES) {
      return;
    }
    this.ranges.set(key, merged);
    for (const oldest of this.ranges.keys()) {
      if (this.ranges.size <= MAX_QUERIES) {
        break;
      }
      this.ranges.delete(oldest);
    }
  }
}

/** Index of the first location whose seq is at least `seq`. */
export function firstAtOrAbove(matches: readonly LineLocation[], seq: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (matches[mid]!.seq < seq) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
