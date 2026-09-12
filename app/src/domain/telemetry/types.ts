import type { AnyValue, Attributes } from "../logs/any-value.ts";

export type Resource = { "service.name": string; [k: string]: AnyValue };
export type Scope = { name: string; version?: string };

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatusCode = "unset" | "ok" | "error";

export type SpanEvent = {
  timeUnixNano: number;
  name: string;
  attributes: Attributes;
};

export type SpanLink = {
  traceId: string;
  spanId: string;
};

export type SpanStatus = {
  code: SpanStatusCode;
  message?: string;
};

export type Span = {
  seq: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startUnixNano: number;
  endUnixNano: number;
  status: SpanStatus;
  attributes: Attributes;
  events: SpanEvent[];
  links: SpanLink[];
  resource: Resource;
  scope?: Scope;
};

export type SpanIngest = Omit<Span, "seq">;

export type TraceTree = {
  traceId: string;
  spans: Span[];
  roots: Span[];
};
