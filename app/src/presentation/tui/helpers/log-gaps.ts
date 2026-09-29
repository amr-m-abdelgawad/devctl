import type { LogRecord } from "../../../domain/logs/logs.ts";

/** Largest page one gap fill asks the daemon for. */
export const GAP_FILL_PAGE = 500;

export type SeqRange = { from: number; to: number };

/**
 * Tracks seq ranges the live stream skipped (during a flood the daemon sends
 * only the newest records of each batch) so the view can page them in once
 * the stream is calm. Seqs are contiguous within one daemon session, so a
 * jump in seq is exactly the set of records the view has not received.
 */
export class LogGapTracker {
  private lastSeq = 0;
  // Ascending and disjoint.
  private gaps: SeqRange[] = [];

  constructor(private readonly window: number) {}

  get pending(): boolean {
    return this.gaps.length > 0;
  }

  /** Notes records as received. Returns true when they open a new gap. */
  observe(records: readonly LogRecord[]): boolean {
    let opened = false;
    for (const record of records) {
      const seq = record.seq;
      if (seq <= 0) {
        continue;
      }
      if (this.lastSeq > 0 && seq > this.lastSeq + 1) {
        this.gaps.push({ from: this.lastSeq + 1, to: seq - 1 });
        opened = true;
      }
      if (seq > this.lastSeq) {
        this.lastSeq = seq;
      } else {
        this.remove({ from: seq, to: seq });
      }
    }
    this.clip(this.lastSeq - Math.max(1, this.window) + 1);
    return opened;
  }

  /**
   * The newest page of the newest gap the view can still show. Nothing older
   * than `oldestHeld` is worth fetching: the view has already trimmed past it.
   */
  next(oldestHeld: number | undefined): SeqRange | undefined {
    if (oldestHeld !== undefined) {
      this.clip(oldestHeld);
    }
    const gap = this.gaps[this.gaps.length - 1];
    if (gap === undefined) {
      return undefined;
    }
    return { from: Math.max(gap.from, gap.to - GAP_FILL_PAGE + 1), to: gap.to };
  }

  /** Records a range as settled, whether or not the daemon still had every record in it. */
  remove(range: SeqRange): void {
    const kept: SeqRange[] = [];
    for (const gap of this.gaps) {
      if (gap.to < range.from || gap.from > range.to) {
        kept.push(gap);
        continue;
      }
      if (gap.from < range.from) {
        kept.push({ from: gap.from, to: range.from - 1 });
      }
      if (gap.to > range.to) {
        kept.push({ from: range.to + 1, to: gap.to });
      }
    }
    this.gaps = kept;
  }

  clear(): void {
    this.gaps = [];
  }

  private clip(floor: number): void {
    if (this.gaps.length === 0 || (this.gaps[0]?.from ?? floor) >= floor) {
      return;
    }
    this.gaps = this.gaps.filter((gap) => gap.to >= floor).map((gap) => (gap.from >= floor ? gap : { from: floor, to: gap.to }));
  }
}

/**
 * Inserts records fetched for a gap into the view in seq order. Records the
 * view already holds win, and records before `since` stay hidden, as for the
 * live stream.
 */
export function mergeGapPage(current: LogRecord[], page: readonly LogRecord[], since: string, cap: number): LogRecord[] {
  const known = new Set<number>();
  for (const row of current) {
    known.add(row.seq);
  }
  const fresh = page
    .filter((event) => event.seq > 0 && !known.has(event.seq) && (since === "" || event.timestamp >= since))
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) {
    return current;
  }
  const merged: LogRecord[] = [];
  let next = 0;
  for (const row of current) {
    while (next < fresh.length && row.seq > 0 && fresh[next]!.seq < row.seq) {
      merged.push(fresh[next]!);
      next += 1;
    }
    merged.push(row);
  }
  while (next < fresh.length) {
    merged.push(fresh[next]!);
    next += 1;
  }
  const limit = Math.max(1, cap);
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
