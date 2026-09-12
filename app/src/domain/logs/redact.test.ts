import { describe, expect, test } from "bun:test";
import { Detector, REDACTED_VALUE } from "../../shared/redaction.ts";
import { logRecord } from "./record.ts";
import { redactLogRecord, redactSpan } from "./redact.ts";
import type { Span } from "../telemetry/types.ts";

describe("recursive telemetry redaction", () => {
  test("redacts nested secrets in body and attributes before storage shape", () => {
    const detector = new Detector(["SESSION"], []);
    const record = logRecord({
      service: "api",
      message: "ok",
      body: { token: "super-secret", nested: { api_key: "abcd" } },
      attributes: { authorization: "Bearer xyz", count: 1 },
      raw: "Authorization: Bearer super-secret-token",
    });
    const redacted = redactLogRecord(detector, record);
    expect(redacted.body).toEqual({ token: REDACTED_VALUE, nested: { api_key: REDACTED_VALUE } });
    expect(redacted.attributes.authorization).toBe(REDACTED_VALUE);
    expect(redacted.attributes.count).toBe(1);
    expect(redacted.raw).toContain(REDACTED_VALUE);
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("abcd");
  });

  test("redacts span attributes and events", () => {
    const detector = new Detector([], []);
    const span: Span = {
      seq: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "GET /",
      kind: "server",
      startUnixNano: 1,
      endUnixNano: 2,
      status: { code: "ok", message: "Authorization: Bearer leak" },
      attributes: { "http.header.authorization": "secret" },
      events: [{ timeUnixNano: 1, name: "exception", attributes: { password: "hunter2" } }],
      links: [],
      resource: { "service.name": "proxy" },
    };
    const redacted = redactSpan(detector, span);
    expect(redacted.attributes["http.header.authorization"]).toBe(REDACTED_VALUE);
    expect(redacted.events[0]?.attributes.password).toBe(REDACTED_VALUE);
    expect(redacted.status.message).toContain(REDACTED_VALUE);
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });
});
