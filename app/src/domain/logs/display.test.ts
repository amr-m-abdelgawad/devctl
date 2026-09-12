import { describe, expect, test } from "bun:test";
import { formatBodyAndAttributes, formatBodySummary } from "./display.ts";
import { logRecord } from "./record.ts";

describe("log headlines", () => {
  test("string bodies stay a sentence, not a dump of every JSON field", () => {
    const line = formatBodyAndAttributes("GET /invoices -> 200", {
      shape: "pino",
      method: "GET",
      path: "/invoices",
      status: 200,
      latency_ms: 12.3,
      seq: 4,
      pid: 99,
    });
    expect(line).toBe("GET /invoices -> 200");
    expect(line).not.toContain("shape=");
    expect(line).not.toContain("seq=");
  });

  test("OTLP HTTP attributes append only when they are not already in the body", () => {
    expect(formatBodyAndAttributes("HTTP request processed", {
      "http.method": "GET",
      "http.route": "/invoices",
      "http.status_code": 404,
      shape: "otlp-http",
    })).toBe("HTTP request processed  GET /invoices 404");
  });

  test("object bodies keep logfmt without noise keys or nested blobs", () => {
    const line = formatBodyAndAttributes(
      { invoice_id: "inv-0004", amount_cents: 1999, currency: "USD", customer: "acme", shape: "no-message-key" },
      { shape: "no-message-key", headers: { authorization: "secret" } },
    );
    expect(line).toContain("invoice_id=inv-0004");
    expect(line).toContain("amount_cents=1999");
    expect(line).not.toContain("shape=");
    expect(line).not.toContain("headers=");
  });

  test("traced rows do not paste 32-hex ids onto the list line", () => {
    const line = formatBodySummary(logRecord({
      message: "cache miss for inv-0004",
      body: "cache miss for inv-0004",
      attributes: {
        shape: "traced",
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        invoice_id: "inv-0004",
        seq: 8,
      },
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    }));
    expect(line).toBe("cache miss for inv-0004");
    expect(line).not.toContain("a".repeat(32));
  });
});
