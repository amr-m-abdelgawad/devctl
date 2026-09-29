import type { LogMatcher } from "../../domain/logs/filter.ts";
import type { LogPageDirection, LogRecord } from "../../domain/logs/logs.ts";

/** How a walk ended. */
export type Walk = {
  /** True when a read budget ran out before the walk reached the end of its source. */
  truncated: boolean;
  /** The last seq examined, in the walk's direction. Where to resume when truncated. */
  frontier: number;
};

/**
 * Matching records in seq order, walked either way from a seq. `visit` sees
 * each match and returns false to stop the walk there.
 */
export type SeqSource = {
  /** Matches with seq below `before`, newest first. */
  walkDown(before: number, visit: (event: LogRecord) => boolean): Walk;
  /** Matches with seq at or above `from`, oldest first. */
  walkUp(from: number, visit: (event: LogRecord) => boolean): Walk;
};

export type SourcePageRequest = {
  cursor?: number;
  direction: LogPageDirection;
  limit: number;
};

export type SourcePage = {
  events: LogRecord[];
  hasPrev: boolean;
  hasNext: boolean;
  /** The seq to page back from when a budget cut the walk short. */
  prevFrontier?: number;
  /** The seq to page on from when a budget cut the walk short. */
  nextFrontier?: number;
};

/** Records held in seq order and reached by index, as the ring holds them. */
export type SeqIndexed = {
  readonly length: number;
  at(index: number): LogRecord | undefined;
  /** Index of the first record whose seq is at least `seq`, or `length`. */
  lowerBound(seq: number): number;
};

/** Matches among records held in memory. Seeks are binary searches, and a walk ends as soon as `visit` has enough. */
export function indexedSource(records: SeqIndexed, matches: LogMatcher): SeqSource {
  return {
    walkDown(before, visit) {
      for (let index = records.lowerBound(before) - 1; index >= 0; index -= 1) {
        const event = records.at(index)!;
        if (matches(event) && !visit(event)) {
          return { truncated: false, frontier: event.seq };
        }
      }
      return { truncated: false, frontier: records.at(0)?.seq ?? before };
    },
    walkUp(from, visit) {
      for (let index = records.lowerBound(from); index < records.length; index += 1) {
        const event = records.at(index)!;
        if (matches(event) && !visit(event)) {
          return { truncated: false, frontier: event.seq };
        }
      }
      return { truncated: false, frontier: records.at(records.length - 1)?.seq ?? from - 1 };
    },
  };
}

/** An array of records already in seq order, oldest first. */
export function seqIndexed(records: readonly LogRecord[]): SeqIndexed {
  return {
    length: records.length,
    at: (index) => (index < 0 ? undefined : records[index]),
    lowerBound: (seq) => {
      let lo = 0;
      let hi = records.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (records[mid]!.seq < seq) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return lo;
    },
  };
}

/**
 * The ring followed, below `boundary` (the ring's oldest seq), by the older
 * part of the window that only disk holds. A walk up from inside the ring
 * never reads the older part.
 */
export function stackedSource(ring: SeqSource, boundary: number, older: SeqSource): SeqSource {
  return {
    walkDown(before, visit) {
      let stopped = false;
      const top = ring.walkDown(before, (event) => {
        stopped = !visit(event);
        return !stopped;
      });
      return stopped ? top : older.walkDown(Math.min(before, boundary), visit);
    },
    walkUp(from, visit) {
      if (from < boundary) {
        let stopped = false;
        const bottom = older.walkUp(from, (event) => {
          stopped = !visit(event);
          return !stopped;
        });
        if (stopped || bottom.truncated) {
          return bottom;
        }
      }
      return ring.walkUp(Math.max(from, boundary), visit);
    },
  };
}

/**
 * One page of matches next to a cursor: the newest `limit` before it, or
 * the oldest `limit` after it going forward. Each walk stops one match past
 * the page, which is all the prev/next flags need. `olderFor` picks where a
 * forward page looks for anything older than its first record.
 */
export function pageSource(
  source: SeqSource,
  request: SourcePageRequest,
  olderFor: (firstSeq: number) => SeqSource = () => source,
): SourcePage {
  const { cursor, limit } = request;
  if (request.direction === "forward" && cursor !== undefined) {
    const events: LogRecord[] = [];
    let more = false;
    const walk = source.walkUp(cursor + 1, (event) => {
      if (events.length < limit) {
        events.push(event);
        return true;
      }
      more = true;
      return false;
    });
    const first = events[0]?.seq;
    return {
      events,
      hasPrev: first !== undefined && hasMatch((visit) => olderFor(first).walkDown(first, visit)),
      hasNext: more || walk.truncated,
      nextFrontier: walk.truncated ? walk.frontier : undefined,
    };
  }
  const newestFirst: LogRecord[] = [];
  let more = false;
  const walk = source.walkDown(cursor ?? Number.POSITIVE_INFINITY, (event) => {
    if (newestFirst.length < limit) {
      newestFirst.push(event);
      return true;
    }
    more = true;
    return false;
  });
  const events = newestFirst.reverse();
  // Nothing newer than the newest page can match; past a cursor, the cursor's own side can.
  const hasNext = cursor !== undefined && events.length > 0 && hasMatch((visit) => source.walkUp(cursor, visit));
  return {
    events,
    hasPrev: more || walk.truncated,
    hasNext,
    prevFrontier: walk.truncated ? walk.frontier : undefined,
  };
}

// True when a walk finds any match, or runs out of budget before it can tell.
function hasMatch(walk: (visit: (event: LogRecord) => boolean) => Walk): boolean {
  let found = false;
  const result = walk(() => {
    found = true;
    return false;
  });
  return found || result.truncated;
}
