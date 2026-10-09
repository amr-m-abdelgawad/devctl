import { REQUEST_ID_ATTR } from "../../domain/logs/ids.ts";
import { approxSpanBytes } from "../../domain/logs/size.ts";
import { NANOS_PER_MS } from "../../domain/logs/types.ts";
import { redactSpan } from "../../domain/logs/redact.ts";
import type { Span, SpanIngest, TraceTree } from "../../domain/telemetry/types.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import type { Detector } from "../../shared/redaction.ts";

const DEFAULT_MAX_SPANS = 10_000;
// Evicted slots are cleared where they are and dropped in one copy once they
// are at least half the array, so eviction is O(1) amortized.
const COMPACT_MIN_SLOTS = 1024;

/**
 * The trace store: the newest spans, capped by count and by a byte budget.
 * One span can carry a whole prompt, so a count alone does not bound it.
 * Spans stay in arrival order; each one's size is taken once, when it is
 * stored, and that same number comes off again when it leaves.
 */
export class SpanManager implements SpanStore {
  private items: Array<Span | undefined> = [];
  private sizes: number[] = [];
  private head = 0;
  private bytes = 0;
  private nextSeq = 1;
  private readonly max: number;
  private maxBytes: number;
  private readonly detector?: Detector;
  private readonly byTrace = new Map<string, Span[]>();
  private readonly requestToTrace = new Map<string, string>();

  /** `maxBytes` of 0 leaves the count as the only cap. */
  constructor(max = DEFAULT_MAX_SPANS, detector?: Detector, maxBytes = 0) {
    this.max = max > 0 ? max : DEFAULT_MAX_SPANS;
    this.detector = detector;
    this.maxBytes = maxBytes;
  }

  get length(): number {
    return this.items.length - this.head;
  }

  byteSize(): number {
    return this.bytes;
  }

  /** Evicts at once down to the new budget. */
  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.evictOverflow();
  }

  append(span: SpanIngest): Span {
    const built: Span = { ...span, seq: this.nextSeq };
    this.nextSeq += 1;
    const next = this.detector ? redactSpan(this.detector, built) : built;
    if (this.length >= this.max) {
      this.evictOldest();
    }
    // Sized as stored: redaction can change a value's length.
    const size = approxSpanBytes(next);
    this.items.push(next);
    this.sizes.push(size);
    this.bytes += size;
    this.index(next);
    this.evictOverflow();
    return next;
  }

  getTrace(traceId: string): TraceTree {
    const spans = [...(this.byTrace.get(traceId) ?? [])].sort((a, b) => a.startUnixNano - b.startUnixNano);
    const ids = new Set(spans.map((span) => span.spanId));
    const roots = spans.filter((span) => !span.parentSpanId || !ids.has(span.parentSpanId));
    return { traceId, spans, roots };
  }

  envelopeMs(traceId: string): number | undefined {
    const spans = this.byTrace.get(traceId);
    if (!spans || spans.length === 0) {
      return undefined;
    }
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const span of spans) {
      const lo = Math.min(span.startUnixNano, span.endUnixNano || span.startUnixNano);
      const hi = Math.max(span.startUnixNano, span.endUnixNano || span.startUnixNano);
      if (lo < start) {
        start = lo;
      }
      if (hi > end) {
        end = hi;
      }
    }
    return Math.max(0, (end - start) / NANOS_PER_MS);
  }

  findTraceIdByRequestId(requestId: string): string | undefined {
    return this.requestToTrace.get(requestId);
  }

  /** The newest spans, newest first. */
  recent(limit = 100): Span[] {
    const out: Span[] = [];
    for (let index = this.items.length - 1; index >= this.head && out.length < limit; index -= 1) {
      out.push(this.items[index]!);
    }
    return out;
  }

  close(): void {
    this.items = [];
    this.sizes = [];
    this.head = 0;
    this.bytes = 0;
    this.byTrace.clear();
    this.requestToTrace.clear();
  }

  // Always keeps the newest span, however large it is.
  private evictOverflow(): void {
    while (this.maxBytes > 0 && this.bytes > this.maxBytes && this.length > 1) {
      this.evictOldest();
    }
  }

  private evictOldest(): void {
    const span = this.items[this.head];
    if (span !== undefined) {
      this.dropFromIndex(span);
      this.bytes -= this.sizes[this.head]!;
    }
    this.items[this.head] = undefined;
    this.head += 1;
    if (this.head >= COMPACT_MIN_SLOTS && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
  }

  private index(span: Span): void {
    const list = this.byTrace.get(span.traceId) ?? [];
    list.push(span);
    this.byTrace.set(span.traceId, list);
    const requestId = span.attributes[REQUEST_ID_ATTR];
    if (typeof requestId === "string" && requestId !== "") {
      this.requestToTrace.set(requestId, span.traceId);
    }
  }

  private dropFromIndex(span: Span): void {
    const list = this.byTrace.get(span.traceId);
    if (!list) {
      return;
    }
    const next = list.filter((item) => item.seq !== span.seq);
    if (next.length === 0) {
      this.byTrace.delete(span.traceId);
      const requestId = span.attributes[REQUEST_ID_ATTR];
      if (typeof requestId === "string" && this.requestToTrace.get(requestId) === span.traceId) {
        this.requestToTrace.delete(requestId);
      }
    } else {
      this.byTrace.set(span.traceId, next);
    }
  }
}
