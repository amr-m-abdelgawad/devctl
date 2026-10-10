import { describe, expect, test } from "bun:test";
import { ProxyHopWindow } from "./hop-window.ts";
import { REQUEST_ID_ATTR } from "./ids.ts";
import { logRecord } from "./record.ts";

const NANOS = 1_000_000;

function hop(atMs: number, requestId = "req-1") {
  return logRecord({
    service: "proxy",
    source: "proxy",
    message: "grpc /temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue route=temporal-grpc",
    request_id: requestId,
    timeUnixNano: atMs * NANOS,
    seq: 1,
  });
}

function line(atMs: number, seq = 2) {
  return logRecord({
    service: "worker",
    source: "stdout",
    message: "ERROR gRPC call poll_activity_task_queue retried 41 times",
    timeUnixNano: atMs * NANOS,
    seq,
  });
}

describe("ProxyHopWindow", () => {
  test("a line takes a hop's request id within the window, however late it commits", () => {
    const window = new ProxyHopWindow();
    window.remember(hop(1_000), 1_000);
    expect(window.attach(line(1_030), 1_030).attributes[REQUEST_ID_ATTR]).toBe("req-1");
    expect(window.attach(line(1_051), 1_051).attributes[REQUEST_ID_ATTR]).toBeUndefined();
  });

  test("a hop tags each earlier line in the window once", () => {
    const window = new ProxyHopWindow();
    window.remember(line(1_000, 7), 1_000);
    window.remember(line(1_200, 8), 1_200);
    const tagged = window.tagEarlier(hop(1_020), 1_020);
    expect(tagged.map((record) => [record.seq, record.attributes[REQUEST_ID_ATTR]])).toEqual([[7, "req-1"]]);
    expect(window.tagEarlier(hop(1_020, "req-2"), 1_020)).toEqual([]);
  });

  test("expiry keeps a candidate until the watermark is a window past it", () => {
    const window = new ProxyHopWindow();
    window.remember(hop(1_000), 1_000);
    window.expire(1_050);
    expect(window.attach(line(1_000), 1_000).attributes[REQUEST_ID_ATTR]).toBe("req-1");
    window.expire(1_051);
    expect(window.attach(line(1_000), 1_000).attributes[REQUEST_ID_ATTR]).toBeUndefined();
  });

  test("keeps only records that can pair", () => {
    const window = new ProxyHopWindow();
    // A hop without a request id cannot tag, and a line that has one cannot be tagged.
    window.remember(logRecord({ service: "proxy", source: "proxy", message: "grpc /x.Y/PollActivityTaskQueue", timeUnixNano: 1_000 * NANOS }), 1_000);
    window.remember(logRecord({ service: "worker", source: "stdout", message: "poll_activity_task_queue", request_id: "own", timeUnixNano: 1_000 * NANOS }), 1_000);
    expect(window.attach(line(1_000), 1_000).attributes[REQUEST_ID_ATTR]).toBeUndefined();
    expect(window.tagEarlier(hop(1_000), 1_000)).toEqual([]);
  });
});
