// Pure formatting helpers shared across pages. No React, no DOM.

export const NANOS_PER_MS = 1_000_000;

/** HH:MM:SS.mmm from an ISO timestamp — for ordering dense request/log rows. */
export function clockMs(ts: string): string {
  return ts.slice(11, 23) || ts;
}

/** Compact "now / 5s / 3m / 2h / 4d" relative to now. */
export function relative(ts: string): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) {
    return ts;
  }
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 2) {
    return "now";
  }
  if (secs < 60) {
    return `${Math.floor(secs)}s`;
  }
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m`;
  }
  if (secs < 86400) {
    return `${Math.floor(secs / 3600)}h`;
  }
  return `${Math.floor(secs / 86400)}d`;
}

/** Inclusive span window; swapped if the exporter sent end before start. */
export function spanBounds(span: { startUnixNano: number; endUnixNano: number }): { start: number; end: number } {
  const start = span.startUnixNano;
  const end = span.endUnixNano || span.startUnixNano;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function spanDurationNs(span: { startUnixNano: number; endUnixNano: number }): number {
  const { start, end } = spanBounds(span);
  return Math.max(0, end - start);
}

/** First-start → last-end across a trace (the waterfall axis). */
export function traceEnvelopeNs(spans: ReadonlyArray<{ startUnixNano: number; endUnixNano: number }>): number {
  if (spans.length === 0) {
    return 0;
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    const bounds = spanBounds(span);
    if (bounds.start < start) {
      start = bounds.start;
    }
    if (bounds.end > end) {
      end = bounds.end;
    }
  }
  return Math.max(0, end - start);
}

/** Human duration from nanoseconds (spans). */
export function durationNs(ns: number): string {
  if (!Number.isFinite(ns) || ns <= 0) {
    return "0ms";
  }
  const ms = ns / NANOS_PER_MS;
  if (ms < 1) {
    return `${(ns / 1000).toFixed(0)}µs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Human duration from milliseconds (proxy request timings). */
export function durationMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}
