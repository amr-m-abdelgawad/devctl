import { describe, expect, test } from "bun:test";
import { NANOS_PER_MS } from "../../domain/logs/types.ts";
import { proxyRecordToSpan } from "./tracing.ts";
import type { ProxyRequestRecord } from "./proxy.ts";

function record(partial: Partial<ProxyRequestRecord> = {}): ProxyRequestRecord {
  return {
    timestamp: "2026-09-12T12:00:00.200Z",
    requestId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    method: "GET",
    path: "/fulfill",
    route: "invoices-api.local",
    identity: "",
    status: 200,
    durationMs: 74,
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    parentSpanId: "cccccccccccccccc",
    ...partial,
  };
}

describe("proxyRecordToSpan", () => {
  test("places the span from request start, not the completion timestamp", () => {
    const span = proxyRecordToSpan(record());
    const endMs = Date.parse("2026-09-12T12:00:00.200Z");
    expect(span.endUnixNano).toBe(endMs * NANOS_PER_MS);
    expect(span.startUnixNano).toBe((endMs - 74) * NANOS_PER_MS);
    expect(span.kind).toBe("server");
    expect(span.resource["service.name"]).toBe("proxy");
    expect(span.parentSpanId).toBe("cccccccccccccccc");
  });

  test("clamps a negative duration to a zero-width span at the timestamp", () => {
    const span = proxyRecordToSpan(record({ durationMs: -12 }));
    const endMs = Date.parse("2026-09-12T12:00:00.200Z");
    expect(span.startUnixNano).toBe(endMs * NANOS_PER_MS);
    expect(span.endUnixNano).toBe(endMs * NANOS_PER_MS);
  });
});
