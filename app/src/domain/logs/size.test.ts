import { describe, expect, test } from "bun:test";
import { logRecord } from "./record.ts";
import { approxRecordBytes } from "./size.ts";

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
