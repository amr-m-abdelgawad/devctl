import { describe, expect, test } from "bun:test";
import { type ProxyRequestSnapshot } from "../../../domain/status.ts";
import { matchProxyRequest, routeLatencies } from "./proxy.ts";

function req(route: string, durationMs: number, status = 200, error?: string): ProxyRequestSnapshot {
  return { timestamp: "2026-09-16T10:00:00.000Z", requestId: `${route}-${durationMs}`, method: "GET", path: "/", route, identity: "", status, durationMs, error };
}

describe("routeLatencies", () => {
  test("groups per route and computes per-route percentiles", () => {
    const rows = routeLatencies([
      req("api", 10),
      req("api", 20),
      req("api", 30),
      req("web", 100),
    ]);
    const api = rows.find((r) => r.route === "api");
    expect(api).toMatchObject({ count: 3, p50: 20, p95: 30, p99: 30, errors: 0 });
    const web = rows.find((r) => r.route === "web");
    expect(web).toMatchObject({ count: 1, p50: 100 });
  });

  test("orders by request count, busiest first", () => {
    const rows = routeLatencies([req("a", 5), req("b", 5), req("b", 6), req("b", 7)]);
    expect(rows.map((r) => r.route)).toEqual(["b", "a"]);
  });

  test("counts 5xx, status 0, and explicit errors as errors", () => {
    const rows = routeLatencies([req("api", 5, 500), req("api", 6, 0), req("api", 7, 200, "reset"), req("api", 8, 200)]);
    expect(rows[0]).toMatchObject({ route: "api", count: 4, errors: 3 });
  });

  test("labels a blank route as (none)", () => {
    expect(routeLatencies([req("", 5)])[0]?.route).toBe("(none)");
  });
});

describe("matchProxyRequest", () => {
  test("prefers an exact request id over an earlier same-trace hop", () => {
    const sharedTrace = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const earlier = { ...req("api", 10), requestId: "req-old", traceId: sharedTrace, identity: "user:old" };
    const exact = { ...req("api", 20), requestId: "req-new", traceId: sharedTrace, identity: "user:new" };
    const matched = matchProxyRequest([earlier, exact], { requestId: "req-new", traceId: sharedTrace });
    expect(matched?.requestId).toBe("req-new");
    expect(matched?.identity).toBe("user:new");
  });

  test("falls back to trace id when the request id is absent from the ring", () => {
    const hop = { ...req("web", 5), requestId: "req-1", traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    expect(matchProxyRequest([hop], { requestId: "missing", traceId: hop.traceId })?.requestId).toBe("req-1");
  });

  test("returns undefined when neither request id nor trace id matches", () => {
    expect(matchProxyRequest([req("api", 5)], { requestId: "missing", traceId: "cccccccccccccccccccccccccccccccc" })).toBeUndefined();
  });
});
