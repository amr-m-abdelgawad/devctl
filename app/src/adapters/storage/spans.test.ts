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
