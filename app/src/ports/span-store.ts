import type { Span, SpanIngest, TraceTree } from "../domain/telemetry/types.ts";

export type SpanStore = {
  append(span: SpanIngest): Span;
  getTrace(traceId: string): TraceTree;
  findTraceIdByRequestId(requestId: string): string | undefined;
  recent(limit?: number): Span[];
  close(): void;
};
