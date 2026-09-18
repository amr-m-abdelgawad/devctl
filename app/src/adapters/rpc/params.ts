import type { LlmCallFilter, LlmCallStatus } from "../../domain/llm/llm.ts";
import type { TrafficCallFilter, TrafficTransport } from "../../domain/traffic/traffic.ts";
import type { LogFilter } from "../../domain/logs/logs.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asLogFilter(rec: Record<string, unknown>): LogFilter {
  return {
    services: asStringArray(rec.services),
    level: typeof rec.level === "string" ? rec.level : "",
    search: typeof rec.search === "string" ? rec.search : "",
    regex: rec.regex === true,
    source: typeof rec.source === "string" ? rec.source : "",
    since: typeof rec.since === "string" ? rec.since : "",
    until: typeof rec.until === "string" ? rec.until : "",
    traceId: nonemptyString(rec.traceId) ?? nonemptyString(rec.trace_id),
    requestId: nonemptyString(rec.requestId) ?? nonemptyString(rec.request_id),
    attribute: asAttributePredicate(rec.attribute),
  };
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asAttributePredicate(value: unknown): { key: string; value: string } | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.value !== "string") {
    return undefined;
  }
  return { key: value.key, value: value.value };
}

function asLlmStatus(value: string): LlmCallStatus | undefined {
  if (value === "ok" || value === "error") {
    return value;
  }
  return undefined;
}

export function asLlmCallFilter(rec: Record<string, unknown>): LlmCallFilter {
  return {
    source: nonemptyString(rec.source),
    sourceType: nonemptyString(rec.sourceType) ?? nonemptyString(rec.source_type),
    model: nonemptyString(rec.model),
    caller: nonemptyString(rec.caller),
    status: asLlmStatus(typeof rec.status === "string" ? rec.status : ""),
    search: nonemptyString(rec.search),
    since: nonemptyString(rec.since),
    until: nonemptyString(rec.until),
    requestId: nonemptyString(rec.requestId) ?? nonemptyString(rec.request_id),
    traceId: nonemptyString(rec.traceId) ?? nonemptyString(rec.trace_id),
  };
}

function asTrafficTransport(value: string): TrafficTransport | undefined {
  if (value === "http" || value === "grpc") {
    return value;
  }
  return undefined;
}

export function asTrafficCallFilter(rec: Record<string, unknown>): TrafficCallFilter {
  return {
    route: nonemptyString(rec.route),
    caller: nonemptyString(rec.caller),
    method: nonemptyString(rec.method),
    status: nonemptyString(typeof rec.status === "string" ? rec.status : rec.status !== undefined ? String(rec.status) : ""),
    search: nonemptyString(rec.search),
    since: nonemptyString(rec.since),
    until: nonemptyString(rec.until),
    requestId: nonemptyString(rec.requestId) ?? nonemptyString(rec.request_id),
    traceId: nonemptyString(rec.traceId) ?? nonemptyString(rec.trace_id),
    transport: asTrafficTransport(typeof rec.transport === "string" ? rec.transport : ""),
  };
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}
