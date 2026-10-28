import { describe, expect, test } from "bun:test";
import { REQUEST_ID_ATTR } from "../../domain/logs/ids.ts";
import { Detector, REDACTED_VALUE } from "../../shared/redaction.ts";
import { SpanManager } from "./spans.ts";
import type { SpanIngest } from "../../domain/telemetry/types.ts";

function ingest(partial: Partial<SpanIngest> & Pick<SpanIngest, "traceId" | "spanId" | "name">): SpanIngest {
  return {
    kind: "server",
    startUnixNano: 1,
    endUnixNano: 2,
    status: { code: "ok" },
    attributes: {},
    events: [],
    links: [],
    resource: { "service.name": "proxy" },
    ...partial,
  };
}

describe("SpanManager", () => {
  test("envelopeMs is first-start to last-end, not a single span", () => {
    const spans = new SpanManager(10);
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    spans.append(ingest({
      traceId,
      spanId: "1111111111111111",
      name: "root",
      startUnixNano: 1_000_000_000,
      endUnixNano: 1_090_000_000,
    }));
    spans.append(ingest({
      traceId,
      spanId: "2222222222222222",
      name: "child",
      startUnixNano: 1_010_000_000,
      endUnixNano: 1_040_000_000,
    }));
    expect(spans.envelopeMs(traceId)).toBe(90);
    expect(spans.envelopeMs("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
  });

  test("indexes spans by trace and request id", () => {
    const spans = new SpanManager(10);
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    spans.append(ingest({
      traceId,
      spanId: "bbbbbbbbbbbbbbbb",
      name: "GET /",
      attributes: { [REQUEST_ID_ATTR]: "req-1" },
    }));
    expect(spans.getTrace(traceId).spans).toHaveLength(1);
    expect(spans.findTraceIdByRequestId("req-1")).toBe(traceId);
    expect(spans.recent(1)[0]?.name).toBe("GET /");
  });

  test("evicts the oldest span and drops an empty trace index", () => {
    const spans = new SpanManager(1);
    spans.append(ingest({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "1111111111111111",
      name: "old",
      attributes: { [REQUEST_ID_ATTR]: "old-req" },
    }));
    spans.append(ingest({
      traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      spanId: "2222222222222222",
      name: "new",
      attributes: { [REQUEST_ID_ATTR]: "new-req" },
    }));
    expect(spans.getTrace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").spans).toHaveLength(0);
    expect(spans.findTraceIdByRequestId("old-req")).toBeUndefined();
    expect(spans.findTraceIdByRequestId("new-req")).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  const KIB = 1024;
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
  // A span whose prompt is `chars` long, carried in an attribute or in an event.
  function big(n: number, chars: number, where: "attribute" | "event" = "attribute"): SpanIngest {
    const prompt = `${n} ${"p".repeat(chars)}`;
    return ingest({
      traceId: hex(n, 32),
      spanId: hex(n, 16),
      name: `chat ${n}`,
      attributes: { [REQUEST_ID_ATTR]: `req-${n}`, ...(where === "attribute" ? { "gen_ai.prompt": prompt } : {}) },
      events: where === "event" ? [{ timeUnixNano: 1, name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": prompt } }] : [],
    });
  }

  test("over its byte budget it drops the oldest spans, with their trace and request-id entries", () => {
    // Room for six 10 KiB spans, and well under the count cap.
    const spans = new SpanManager(1_000, undefined, 64 * KIB);
    for (let n = 1; n <= 20; n += 1) {
      spans.append(big(n, 10 * KIB));
    }
    expect(spans.byteSize()).toBeLessThanOrEqual(64 * KIB);
    expect(spans.length).toBeGreaterThanOrEqual(5);
    expect(spans.length).toBeLessThan(7);
    const kept = spans.recent(1_000).map((span) => span.name);
    expect(kept).toEqual(Array.from({ length: spans.length }, (_, i) => `chat ${20 - i}`));
    for (let n = 1; n <= 20; n += 1) {
      const held = n > 20 - spans.length;
      expect(spans.getTrace(hex(n, 32)).spans).toHaveLength(held ? 1 : 0);
      expect(spans.findTraceIdByRequestId(`req-${n}`)).toBe(held ? hex(n, 32) : undefined);
    }
  });

  test("a payload carried in an event counts as one in an attribute does", () => {
    const inAttribute = new SpanManager(10);
    const inEvent = new SpanManager(10);
    inAttribute.append(big(1, 50 * KIB, "attribute"));
    inEvent.append(big(1, 50 * KIB, "event"));
    expect(inAttribute.byteSize()).toBeGreaterThan(50 * KIB);
    expect(inEvent.byteSize()).toBeGreaterThan(50 * KIB);
    // Every attribute is counted, however many a span has.
    const many = new SpanManager(10);
    many.append(ingest({ traceId: hex(1, 32), spanId: hex(1, 16), name: "wide", attributes: Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, "v".repeat(1_000)])) }));
    expect(many.byteSize()).toBeGreaterThan(2_000 * 1_000);
  });

  test("a span larger than the whole budget is kept until the next one arrives", () => {
    const spans = new SpanManager(1_000, undefined, 8 * KIB);
    spans.append(big(1, 100 * KIB));
    expect(spans.recent().map((span) => span.name)).toEqual(["chat 1"]);
    spans.append(big(2, 100 * KIB));
    expect(spans.recent().map((span) => span.name)).toEqual(["chat 2"]);
    expect(spans.getTrace(hex(1, 32)).spans).toHaveLength(0);
  });

  test("a smaller budget evicts at once, and the count cap still applies beside it", () => {
    const spans = new SpanManager(8, undefined, 1024 * KIB);
    for (let n = 1; n <= 30; n += 1) {
      spans.append(big(n, 10 * KIB));
    }
    // The count caps it first: eight spans of 10 KiB are far under a megabyte.
    expect(spans.recent(100).map((span) => span.name)).toEqual([30, 29, 28, 27, 26, 25, 24, 23].map((n) => `chat ${n}`));
    // Each span is about 11 KiB as sized, so three fit and a fourth does not.
    spans.setMaxBytes(36 * KIB);
    expect(spans.byteSize()).toBeLessThanOrEqual(36 * KIB);
    expect(spans.recent(100).map((span) => span.name)).toEqual(["chat 30", "chat 29", "chat 28"]);
    expect(spans.findTraceIdByRequestId("req-27")).toBeUndefined();
    // Back at the larger budget, new spans fill it again in order.
    spans.setMaxBytes(1024 * KIB);
    spans.append(big(31, 10 * KIB));
    expect(spans.recent(2).map((span) => span.name)).toEqual(["chat 31", "chat 30"]);
  });

  test("keeps its order and its size through thousands of evictions, and close empties it", () => {
    const spans = new SpanManager(100, undefined, 4096 * KIB);
    for (let n = 1; n <= 5_000; n += 1) {
      spans.append(big(n, n % 7 === 0 ? 20 * KIB : 200));
    }
    const names = spans.recent(1_000).map((span) => span.name);
    expect(names).toEqual(Array.from({ length: 100 }, (_, i) => `chat ${5_000 - i}`));
    expect(spans.byteSize()).toBeLessThanOrEqual(4096 * KIB);
    // What it reports is what it holds: the same spans stored afresh take the same bytes.
    const again = new SpanManager(100);
    for (let n = 4_901; n <= 5_000; n += 1) {
      again.append(big(n, n % 7 === 0 ? 20 * KIB : 200));
    }
    expect(spans.byteSize()).toBe(again.byteSize());
    spans.close();
    expect(spans.byteSize()).toBe(0);
    expect(spans.recent()).toEqual([]);
    spans.append(big(1, 200));
    expect(spans.recent().map((span) => span.name)).toEqual(["chat 1"]);
  });

  test("redacts secrets in attributes and events before they are stored", () => {
    const detector = new Detector([], []);
    const spans = new SpanManager(10, detector);
    const stored = spans.append(ingest({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      name: "GET /",
      attributes: { "http.header.authorization": "secret" },
      events: [{ timeUnixNano: 1, name: "exception", attributes: { password: "hunter2" } }],
    }));
    expect(stored.attributes["http.header.authorization"]).toBe(REDACTED_VALUE);
    expect(stored.events[0]?.attributes.password).toBe(REDACTED_VALUE);
    expect(JSON.stringify(spans.getTrace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).not.toContain("hunter2");
  });
});
