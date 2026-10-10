import { describe, expect, test } from "bun:test";
import { logRecord } from "./record.ts";
import { approxRecordBytes, approxSpanBytes } from "./size.ts";

describe("approximate record size", () => {
  test("counts attributes and resource, not only the body", () => {
    const plain = logRecord({ seq: 1, service: "api", message: "hello", resource: { "service.name": "api" } });
    const attributed = logRecord({
      seq: 1,
      service: "api",
      message: "hello",
      attributes: { "http.request_id": "r".repeat(2_000) },
      resource: { "service.name": "api", "host.name": "h".repeat(3_000) },
    });
    expect(approxRecordBytes(attributed) - approxRecordBytes(plain)).toBeGreaterThanOrEqual(5_000);
  });

  test("ASCII counts one byte per unit and wide text counts two", () => {
    const ascii = logRecord({ seq: 1, service: "api", message: "a".repeat(10_000), resource: { "service.name": "api" } });
    const cjk = logRecord({ seq: 1, service: "api", message: "你".repeat(10_000), resource: { "service.name": "api" } });
    const base = approxRecordBytes(logRecord({ seq: 1, service: "api", message: "", resource: { "service.name": "api" } }));
    expect(approxRecordBytes(ascii) - base).toBe(10_000);
    expect(approxRecordBytes(cjk) - base).toBe(20_000);
    const raw = logRecord({ seq: 1, service: "api", message: "", raw: `{"msg":"${"é".repeat(1_000)}"}`, resource: { "service.name": "api" } });
    expect(approxRecordBytes(raw) - base).toBe(2 * (raw.raw?.length ?? 0));
  });
});

describe("approximate span size", () => {
  const span = (extra: Partial<Parameters<typeof approxSpanBytes>[0]> = {}): Parameters<typeof approxSpanBytes>[0] => ({
    name: "chat",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    status: {},
    attributes: {},
    events: [],
    links: [],
    resource: { "service.name": "agent" },
    ...extra,
  });

  test("a small span costs its fixed overhead, and each string adds its bytes", () => {
    const base = approxSpanBytes(span());
    expect(base).toBeGreaterThan(700);
    expect(base).toBeLessThan(1_000);
    expect(approxSpanBytes(span({ attributes: { "gen_ai.prompt": "p".repeat(100_000) } })) - base).toBeGreaterThanOrEqual(100_000);
    expect(approxSpanBytes(span({ attributes: { "gen_ai.prompt": "你".repeat(100_000) } })) - base).toBeGreaterThanOrEqual(200_000);
    expect(approxSpanBytes(span({ status: { message: "m".repeat(5_000) } })) - base).toBe(5_000);
  });

  test("events, the resource and nested values are counted, with no limit on how many", () => {
    const base = approxSpanBytes(span());
    const events = Array.from({ length: 1_000 }, (_, i) => ({ name: "token", attributes: { text: "t".repeat(1_000), index: i } }));
    expect(approxSpanBytes(span({ events })) - base).toBeGreaterThanOrEqual(1_000 * 1_000);
    expect(approxSpanBytes(span({ resource: { "service.name": "agent", "process.command_line": "c".repeat(30_000) } })) - base).toBeGreaterThanOrEqual(30_000);
    expect(approxSpanBytes(span({ attributes: { messages: [{ role: "user", content: "c".repeat(40_000) }] } })) - base).toBeGreaterThanOrEqual(40_000);
  });
});
