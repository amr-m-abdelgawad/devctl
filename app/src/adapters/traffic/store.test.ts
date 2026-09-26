import { describe, expect, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import { TRAFFIC_TRANSPORT_HTTP, type TrafficCallIngest } from "../../domain/traffic/traffic.ts";
import { TrafficCallRing } from "./store.ts";

function ingest(id: string, overrides: Partial<TrafficCallIngest> = {}): TrafficCallIngest {
  return {
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    method: "GET",
    path: "/ok",
    route: "api",
    transport: TRAFFIC_TRANSPORT_HTTP,
    status: 200,
    attributes: {},
    ...overrides,
  };
}

describe("TrafficCallRing", () => {
  test("upserts by id, redacts at ingest, and pages newest first", () => {
    const store = new TrafficCallRing(new Detector(["token"], []), 10);
    store.upsert([
      ingest("a", { timestamp: "2026-01-01T00:00:01.000Z", request: { text: '{"token":"secret-a-0123456789abcd"}' } }),
      ingest("b", { timestamp: "2026-01-01T00:00:02.000Z" }),
    ]);
    store.upsert([ingest("a", { timestamp: "2026-01-01T00:00:03.000Z", path: "/updated" })]);
    const page = store.queryPage({});
    expect(page.calls.map((call) => call.id)).toEqual(["a", "b"]);
    expect(page.calls[0]?.path).toBe("/updated");
    expect(JSON.stringify(store.get("a"))).not.toContain("secret-a-0123456789abcd");
    const next = store.queryPage({}, { cursor: page.nextCursor, limit: 1 });
    expect(next.calls).toHaveLength(0);
    expect(next.hasNext).toBe(false);
  });

  test("trims to cap and can install secrets later", () => {
    const store = new TrafficCallRing(undefined, 2);
    store.upsert([ingest("a"), ingest("b"), ingest("c")]);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
    store.setSecrets(["token"], []);
    store.upsert([ingest("d", { request: { text: '{"token":"still-secret-0123456789"}' } })]);
    expect(JSON.stringify(store.get("d"))).not.toContain("still-secret-0123456789");
    store.close();
    expect(store.get("d")).toBeUndefined();
  });
});
