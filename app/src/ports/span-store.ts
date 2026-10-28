import type { Span, SpanIngest, TraceTree } from "../domain/telemetry/types.ts";

export type SpanStore = {
  append(span: SpanIngest): Span;
  getTrace(traceId: string): TraceTree;
  envelopeMs(traceId: string): number | undefined;
  findTraceIdByRequestId(requestId: string): string | undefined;
  recent(limit?: number): Span[];
  /** Changes the store's byte budget and evicts down to it. */
  setMaxBytes?(maxBytes: number): void;
  close(): void;
};
