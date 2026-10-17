import { describe, expect, test } from "bun:test";
import { logRecord } from "../../domain/logs/record.ts";
import type { Envelope } from "../../types.ts";
import { OutboundQueue } from "./outbound-queue.ts";

function batchEnvelope(seq: number): Envelope {
  return {
    event: {
      type: "LogBatch",
      payload: { session: "s", firstSeq: seq, lastSeq: seq, newest: [logRecord({ seq, service: "api", message: `m${seq}` })], replaced: [], skipped: 0 },
    },
  };
}

function eventType(env: Envelope): string | undefined {
  const event = env.event as { type?: unknown } | undefined;
  return typeof event?.type === "string" ? event.type : undefined;
}

describe("outbound queue", () => {
  test("holds at most one pending live batch per connection and never drops control traffic", () => {
    const queue = new OutboundQueue();
    queue.push({ id: "7", result: "pong" });
    for (let seq = 1; seq <= 10_000; seq += 1) {
      queue.push(batchEnvelope(seq));
    }
    queue.push({ event: { type: "ServiceStateChanged", payload: { state: "running" } } });
    const drained = queue.drain();
    const batches = drained.filter((env) => eventType(env) === "LogBatch");
    expect(batches).toHaveLength(1);
    const payload = (batches[0]!.event as { payload: { firstSeq: number; lastSeq: number; newest: unknown[]; skipped: number } }).payload;
    expect(payload.firstSeq).toBe(1);
    expect(payload.lastSeq).toBe(10_000);
    expect(payload.newest.length).toBeLessThanOrEqual(500);
    expect(payload.skipped).toBe(10_000 - payload.newest.length);
    expect(drained.some((env) => env.id === "7")).toBe(true);
    expect(drained.some((env) => eventType(env) === "ServiceStateChanged")).toBe(true);
  });

  test("caps legacy per-record events and keeps every response", () => {
    const queue = new OutboundQueue({ maxLegacyEvents: 2_000 });
    for (let seq = 1; seq <= 5_000; seq += 1) {
      queue.push({ event: { type: "LogReceived", payload: { event: logRecord({ seq, service: "api" }) } } });
      if (seq % 1_000 === 0) {
        queue.push({ id: String(seq), result: null });
      }
    }
    const drained = queue.drain();
    expect(drained.filter((env) => eventType(env) === "LogReceived").length).toBeLessThanOrEqual(2_000);
    expect(drained.filter((env) => env.id !== undefined)).toHaveLength(5);
  });
});
