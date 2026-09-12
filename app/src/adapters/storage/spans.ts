import { REQUEST_ID_ATTR } from "../../domain/logs/ids.ts";
import { redactSpan } from "../../domain/logs/redact.ts";
import type { Span, SpanIngest, TraceTree } from "../../domain/telemetry/types.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import type { Detector } from "../../shared/redaction.ts";

const DEFAULT_MAX_SPANS = 10_000;

export class SpanManager implements SpanStore {
  private readonly items: Span[] = [];
  private start = 0;
  private nextSeq = 1;
  private readonly max: number;
  private readonly detector?: Detector;
  private readonly byTrace = new Map<string, Span[]>();
  private readonly requestToTrace = new Map<string, string>();

  constructor(max = DEFAULT_MAX_SPANS, detector?: Detector) {
    this.max = max > 0 ? max : DEFAULT_MAX_SPANS;
    this.detector = detector;
  }

  append(span: SpanIngest): Span {
    const built: Span = { ...span, seq: this.nextSeq };
    this.nextSeq += 1;
    const next = this.detector ? redactSpan(this.detector, built) : built;
    if (this.items.length < this.max) {
      this.items.push(next);
    } else {
      const evicted = this.items[this.start];
      if (evicted) {
        this.dropFromIndex(evicted);
      }
      this.items[this.start] = next;
      this.start = (this.start + 1) % this.max;
    }
    this.index(next);
    return next;
  }

  getTrace(traceId: string): TraceTree {
    const spans = [...(this.byTrace.get(traceId) ?? [])].sort((a, b) => a.startUnixNano - b.startUnixNano);
    const ids = new Set(spans.map((span) => span.spanId));
    const roots = spans.filter((span) => !span.parentSpanId || !ids.has(span.parentSpanId));
    return { traceId, spans, roots };
  }

  findTraceIdByRequestId(requestId: string): string | undefined {
    return this.requestToTrace.get(requestId);
  }

  recent(limit = 100): Span[] {
    const out: Span[] = [];
    this.forEach((span) => {
      out.push(span);
    });
    return out.slice(Math.max(0, out.length - limit)).reverse();
  }

  close(): void {
    this.items.length = 0;
    this.byTrace.clear();
    this.requestToTrace.clear();
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

  private forEach(visit: (span: Span) => void): void {
    const count = this.items.length;
    for (let offset = 0; offset < count; offset += 1) {
      const span = this.items[(this.start + offset) % count];
      if (span) {
        visit(span);
      }
    }
  }
}
