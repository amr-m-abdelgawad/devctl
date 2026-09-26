import { describe, expect, test } from "bun:test";
import { Detector, REDACTED_VALUE } from "../../shared/redaction.ts";
import type { Span } from "../telemetry/types.ts";
import { MAX_ANY_VALUE_DEPTH, type AnyValue } from "./any-value.ts";
import { logRecord } from "./record.ts";
import { redactAnyValue, redactLogRecord, redactSpan } from "./redact.ts";

describe("recursive telemetry redaction", () => {
  test("redacts nested secrets in body and attributes before storage shape", () => {
    const detector = new Detector(["SESSION"], []);
    const record = logRecord({
      service: "api",
      message: "ok",
      body: { token: "super-secret-token-value", nested: { api_key: "abcd" } },
      attributes: { authorization: "Bearer xyz", count: 1 },
      raw: "Authorization: Bearer super-secret-token-value",
    });
    const redacted = redactLogRecord(detector, record);
    expect(redacted.body).toEqual({ token: REDACTED_VALUE, nested: { api_key: REDACTED_VALUE } });
    expect(redacted.attributes.authorization).toBe(REDACTED_VALUE);
    expect(redacted.attributes.count).toBe(1);
    expect(redacted.raw).toContain(REDACTED_VALUE);
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("abcd");
  });

  test("does not redact LLM usage counts whose keys contain TOKEN as a substring", () => {
    const detector = new Detector([], []);
    const record = logRecord({
      service: "api",
      message: "ok",
      body: { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }, max_tokens: 256 },
    });
    const redacted = redactLogRecord(detector, record);
    expect(redacted.body).toEqual({ usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }, max_tokens: 256 });
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
      status: { code: "ok", message: "Authorization: Bearer super-secret-token-value" },
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

  test("walks objects and keeps metadata that only mentions a secret", () => {
    const detector = new Detector([], []);
    const record = logRecord({
      service: "api",
      message: "ok",
      body: {
        secret: { name: "projects/foo", password: "hunter2" },
        token: "Hello",
        token_type: "Bearer",
        page_token: "cursor-1",
        token_count: 4,
        count: 3,
      },
    });
    const redacted = redactLogRecord(detector, record);
    expect(redacted.body).toEqual({
      secret: { name: "projects/foo", password: REDACTED_VALUE },
      token: "Hello",
      token_type: "Bearer",
      page_token: "cursor-1",
      token_count: 4,
      count: 3,
    });
  });

  test("depth cap keeps the nested value instead of masking it", () => {
    const detector = new Detector([], []);
    let value: AnyValue = { password: "hunter2" };
    for (let i = 0; i < MAX_ANY_VALUE_DEPTH; i++) {
      value = { child: value };
    }
    const redacted = redactAnyValue(detector, value);
    expect(JSON.stringify(redacted)).toContain("hunter2");
    expect(redacted).not.toBe(REDACTED_VALUE);
  });

  test("redact disabled leaves the payload unchanged", () => {
    const detector = new Detector([], [], false);
    const record = logRecord({
      service: "api",
      message: "ok",
      body: { password: "hunter2", token: "Hello" },
      raw: "Authorization: Bearer super-secret-token-value",
    });
    const redacted = redactLogRecord(detector, record);
    expect(redacted.body).toEqual({ password: "hunter2", token: "Hello" });
    expect(redacted.raw).toContain("super-secret-token-value");
  });
});
