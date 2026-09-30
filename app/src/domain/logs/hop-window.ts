import { isProxyHopLog, PROXY_HOP_CORRELATE_WINDOW_MS, shouldTagServiceLogWithProxyHop, withRequestId } from "./correlate.ts";
import { requestIdAttribute } from "./dedupe.ts";
import type { LogRecord } from "./types.ts";

/** Most proxy hops held for service lines that commit late. */
const MAX_HOPS = 4_096;
/** Most untagged service lines held for a hop that commits late. */
const MAX_LINES = 8_192;
const COMPACT_AFTER = 1_024;

type Candidate = { event: LogRecord; atMs: number };

// Oldest first by commit order. Event times are only roughly ordered, so
// expiry stops at the first candidate still in range; the match check keeps
// that exact.
class CandidateQueue {
  private items: Candidate[] = [];
  private head = 0;

  constructor(private readonly max: number) {}

  push(candidate: Candidate): void {
    this.items.push(candidate);
    if (this.items.length - this.head > this.max) {
      this.head = this.items.length - this.max;
    }
    this.compact();
  }

  expireBefore(cutoffMs: number): void {
    while (this.head < this.items.length && this.items[this.head]!.atMs < cutoffMs) {
      this.head += 1;
    }
    this.compact();
  }

  find(match: (candidate: Candidate) => boolean): Candidate | undefined {
    for (let index = this.head; index < this.items.length; index += 1) {
      if (match(this.items[index]!)) {
        return this.items[index];
      }
    }
    return undefined;
  }

  /** Replaces every candidate `update` returns a new record for, and returns the new records. */
  update(update: (candidate: Candidate) => LogRecord | undefined): LogRecord[] {
    const updated: LogRecord[] = [];
    for (let index = this.head; index < this.items.length; index += 1) {
      const candidate = this.items[index]!;
      const next = update(candidate);
      if (next !== undefined) {
        this.items[index] = { event: next, atMs: candidate.atMs };
        updated.push(next);
      }
    }
    return updated;
  }

  private compact(): void {
    if (this.head >= COMPACT_AFTER && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}

function near(leftMs: number, rightMs: number): boolean {
  return Math.abs(leftMs - rightMs) <= PROXY_HOP_CORRELATE_WINDOW_MS;
}

/**
 * Pairs proxy hops with the service lines they caused by event time: when the
 * line was read and when the hop was logged, not when either was committed.
 * A spooled service stream therefore pairs the way it would have live. Only
 * hops with a request id and service lines without one are kept, and each
 * stays until the low watermark (the oldest event time still to come) has
 * passed it by a window.
 */
export class ProxyHopWindow {
  private readonly hops = new CandidateQueue(MAX_HOPS);
  private readonly lines = new CandidateQueue(MAX_LINES);

  /** A service line without a request id takes one from a hop within the window. */
  attach(event: LogRecord, atMs: number): LogRecord {
    if (requestIdAttribute(event) !== "" || isProxyHopLog(event)) {
      return event;
    }
    const hop = this.hops.find((candidate) => near(candidate.atMs, atMs) && shouldTagServiceLogWithProxyHop(candidate.event, event));
    return hop === undefined ? event : withRequestId(event, requestIdAttribute(hop.event));
  }

  /** Service lines committed before this hop that it tags, each updated. */
  tagEarlier(hop: LogRecord, atMs: number): LogRecord[] {
    const requestId = requestIdAttribute(hop);
    if (requestId === "" || !isProxyHopLog(hop)) {
      return [];
    }
    return this.lines.update((candidate) =>
      near(candidate.atMs, atMs) && shouldTagServiceLogWithProxyHop(hop, candidate.event) ? withRequestId(candidate.event, requestId) : undefined,
    );
  }

  remember(event: LogRecord, atMs: number): void {
    const hasId = requestIdAttribute(event) !== "";
    if (isProxyHopLog(event)) {
      if (hasId) {
        this.hops.push({ event, atMs });
      }
      return;
    }
    if (!hasId) {
      this.lines.push({ event, atMs });
    }
  }

  /** Drops candidates that no record at or after `watermarkMs` can pair with. */
  expire(watermarkMs: number): void {
    const cutoff = watermarkMs - PROXY_HOP_CORRELATE_WINDOW_MS;
    this.hops.expireBefore(cutoff);
    this.lines.expireBefore(cutoff);
  }
}
