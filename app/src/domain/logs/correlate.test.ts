import { describe, expect, test } from "bun:test";
import { REQUEST_ID_ATTR } from "./ids.ts";
import { logRecord } from "./record.ts";
import { NANOS_PER_MS } from "./types.ts";
import {
  mentionsProxyHop,
  proxyHopNeedle,
  shouldTagServiceLogWithProxyHop,
  withRequestId,
} from "./correlate.ts";

const T0 = Date.parse("2026-09-19T00:00:00.000Z") * NANOS_PER_MS;

function proxyHop(opts: { offsetMs?: number; message: string; caller?: string }) {
  return logRecord({
    seq: 1,
    service: "proxy",
    source: "proxy",
    timeUnixNano: T0 + (opts.offsetMs ?? 0) * NANOS_PER_MS,
    message: opts.message,
    body: opts.message,
    request_id: "req-1",
    attributes: opts.caller ? { caller: opts.caller } : undefined,
  });
}

function serviceLine(opts: { offsetMs?: number; service?: string; message: string; requestId?: string }) {
  return logRecord({
    seq: 2,
    service: opts.service ?? "worker",
    source: "stdout",
    timeUnixNano: T0 + (opts.offsetMs ?? 0) * NANOS_PER_MS,
    message: opts.message,
    body: opts.message,
    request_id: opts.requestId,
  });
}

describe("proxy hop request-id correlation", () => {
  test("extracts the gRPC method leaf and HTTP method+path", () => {
    expect(proxyHopNeedle("grpc /temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue route=temporal-grpc")).toBe("PollActivityTaskQueue");
    expect(proxyHopNeedle("GET /assistant/chat route=agent")).toBe("GET /assistant/chat");
    expect(proxyHopNeedle("GET http://llm.local/v1/chat/completions")).toBe("GET http://llm.local/v1/chat/completions");
    expect(proxyHopNeedle("CONNECT invoices-api.local:443")).toBe("CONNECT invoices-api.local:443");
    expect(proxyHopNeedle("OPTIONS *")).toBe("OPTIONS *");
    expect(proxyHopNeedle("ERROR upstream")).toBe("");
    expect(proxyHopNeedle("not a hop")).toBe("");
  });

  test("matches PascalCase methods as snake_case in SDK lines", () => {
    expect(mentionsProxyHop("gRPC call poll_activity_task_queue retried", "PollActivityTaskQueue")).toBe(true);
    expect(mentionsProxyHop("INFO GET /assistant/chat HTTP/1.1", "GET /assistant/chat")).toBe(true);
    expect(mentionsProxyHop("unrelated warn", "PollActivityTaskQueue")).toBe(false);
  });

  test("tags a worker SDK line that names the same hop within the window", () => {
    const proxy = proxyHop({
      message: "grpc /temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue route=temporal-grpc grpc-status=14",
    });
    const worker = serviceLine({
      message: "ERROR temporalio_client::retry: gRPC call poll_activity_task_queue retried 41 times",
    });
    expect(shouldTagServiceLogWithProxyHop(proxy, worker)).toBe(true);
    expect(withRequestId(worker, "req-1").attributes[REQUEST_ID_ATTR]).toBe("req-1");
  });

  test("does not treat ERROR upstream as an HTTP hop", () => {
    const proxy = proxyHop({ message: "ERROR upstream" });
    expect(shouldTagServiceLogWithProxyHop(proxy, serviceLine({ message: "ERROR upstream timed out" }))).toBe(false);
  });

  test("does not tag a different method, a late line, or a mismatched caller", () => {
    const proxy = proxyHop({
      message: "grpc /svc/PollActivityTaskQueue route=temporal-grpc",
      caller: "worker",
    });
    expect(shouldTagServiceLogWithProxyHop(proxy, serviceLine({ message: "poll_workflow_task_queue" }))).toBe(false);
    expect(shouldTagServiceLogWithProxyHop(proxy, serviceLine({ offsetMs: 80, message: "poll_activity_task_queue" }))).toBe(false);
    expect(shouldTagServiceLogWithProxyHop(proxy, serviceLine({ service: "other", message: "poll_activity_task_queue" }))).toBe(false);
  });
});
