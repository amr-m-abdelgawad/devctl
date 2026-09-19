import { describe, expect, test } from "bun:test";
import { REQUEST_ID_ATTR } from "./ids.ts";
import { logRecord } from "./record.ts";
import { NANOS_PER_MS } from "./types.ts";
import { dedupeLogsByRequestId, requestIdAttribute } from "./dedupe.ts";

const T0 = Date.parse("2026-09-19T00:00:00.000Z") * NANOS_PER_MS;

function ev(opts: {
  seq: number;
  requestId?: string;
  offsetMs?: number;
  body?: string;
  attributes?: Record<string, string | number>;
}): ReturnType<typeof logRecord> {
  return logRecord({
    seq: opts.seq,
    service: "api",
    source: opts.attributes ? "proxy" : "stdout",
    timeUnixNano: T0 + (opts.offsetMs ?? 0) * NANOS_PER_MS,
    message: opts.body ?? `line ${opts.seq}`,
    body: opts.body ?? `line ${opts.seq}`,
    attributes: {
      ...(opts.requestId ? { [REQUEST_ID_ATTR]: opts.requestId } : {}),
      ...(opts.attributes ?? {}),
    },
  });
}

describe("dedupeLogsByRequestId", () => {
  test("same request id within 20ms collapses", () => {
    const proxy = ev({
      seq: 1,
      requestId: "req-1",
      body: "GET /health 200",
      attributes: { method: "GET", path: "/health", status: 200 },
    });
    const stdout = ev({ seq: 2, requestId: "req-1", offsetMs: 12, body: "handler ok" });
    const out = dedupeLogsByRequestId([proxy, stdout]);
    expect(out).toHaveLength(1);
    expect(requestIdAttribute(out[0]!)).toBe("req-1");
  });

  test("same request id outside the window keeps both", () => {
    const first = ev({ seq: 1, requestId: "req-1", body: "first" });
    const second = ev({ seq: 2, requestId: "req-1", offsetMs: 21, body: "second" });
    expect(dedupeLogsByRequestId([first, second])).toEqual([first, second]);
  });

  test("events without a request id are unchanged", () => {
    const a = ev({ seq: 1, body: "plain a" });
    const b = ev({ seq: 2, offsetMs: 1, body: "plain b" });
    expect(dedupeLogsByRequestId([a, b])).toEqual([a, b]);
  });

  test("keeps proxy attributes and the richer body", () => {
    const proxy = ev({
      seq: 1,
      requestId: "req-1",
      body: "short",
      attributes: { method: "GET", path: "/health", status: 200, route: "api" },
    });
    const stdout = ev({
      seq: 2,
      requestId: "req-1",
      offsetMs: 5,
      body: "the longer service body",
    });
    const out = dedupeLogsByRequestId([proxy, stdout]);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("the longer service body");
    expect(out[0]?.attributes.method).toBe("GET");
    expect(out[0]?.attributes.path).toBe("/health");
    expect(out[0]?.attributes.status).toBe(200);
    expect(out[0]?.attributes.route).toBe("api");
    expect(out[0]?.source).toBe("proxy");
  });

  test("keeps the earlier sequence and timestamp when the later record survives", () => {
    const stdout = ev({ seq: 1, requestId: "req-1", body: "short" });
    const proxy = ev({
      seq: 2,
      requestId: "req-1",
      offsetMs: 5,
      body: "GET /health 200",
      attributes: { method: "GET", path: "/health", status: 200 },
    });
    const between = ev({ seq: 3, offsetMs: 8, body: "unrelated" });
    const out = dedupeLogsByRequestId([stdout, proxy, between]);
    expect(out.map((item) => item.seq)).toEqual([1, 3]);
    expect(out[0]?.source).toBe("proxy");
    expect(out[0]?.body).toBe("GET /health 200");
    expect(out[0]?.timeUnixNano).toBe(stdout.timeUnixNano);
    expect(out[1]?.body).toBe("unrelated");
  });

  test("exactly 20ms still collapses", () => {
    const first = ev({ seq: 1, requestId: "req-1", body: "a" });
    const second = ev({ seq: 2, requestId: "req-1", offsetMs: 20, body: "bb" });
    const out = dedupeLogsByRequestId([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("bb");
  });
});
