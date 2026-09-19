import { describe, expect, test } from "bun:test";
import { Detector, REDACTED_VALUE } from "../../shared/redaction.ts";
import { matchesTrafficCall } from "./match.ts";
import { grpcTrafficPayload, httpTrafficPayload, prettyGrpcMessage } from "./payload.ts";
import { redactTrafficCall, stripTrafficBodies } from "./redact.ts";
import { clampTrafficPageSize, trafficIsError, type TrafficCall } from "./types.ts";

function call(overrides: Partial<TrafficCall> = {}): TrafficCall {
  return {
    seq: 1,
    id: "req-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/invoices",
    route: "invoices-api",
    transport: "http",
    status: 200,
    attributes: {},
    ...overrides,
  };
}

function grpcFrame(message: string): Buffer {
  const body = Buffer.from(message, "utf8");
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(body.length, 1);
  return Buffer.concat([prefix, body]);
}

describe("traffic domain", () => {
  test("clamps page size and classifies errors", () => {
    expect(clampTrafficPageSize(undefined)).toBe(100);
    expect(clampTrafficPageSize(9_000)).toBe(500);
    expect(trafficIsError({ status: 500 })).toBe(true);
    expect(trafficIsError({ status: 200, grpcStatus: "14" })).toBe(true);
    expect(trafficIsError({ status: 200, grpcStatus: "0" })).toBe(false);
  });

  test("matches filters including search over bodies", () => {
    const row = call({
      caller: "worker",
      requestId: "req-1",
      request: { text: '{"secret":"hello"}' },
    });
    expect(matchesTrafficCall({ route: "invoices-api", method: "post" }, row)).toBe(true);
    expect(matchesTrafficCall({ caller: "worker" }, row)).toBe(true);
    expect(matchesTrafficCall({ caller: "api" }, row)).toBe(false);
    expect(matchesTrafficCall({ caller: "-" }, row)).toBe(false);
    expect(matchesTrafficCall({ caller: "-" }, call({ caller: undefined }))).toBe(true);
    expect(matchesTrafficCall({ search: "hello" }, row)).toBe(true);
    expect(matchesTrafficCall({ requestId: "req-1" }, row)).toBe(true);
    expect(matchesTrafficCall({ status: "ok" }, row)).toBe(true);
    expect(matchesTrafficCall({ status: "error" }, row)).toBe(false);
    expect(matchesTrafficCall({ transport: "grpc" }, row)).toBe(false);
  });

  test("redacts secrets in bodies and can drop them", () => {
    const detector = new Detector(["api_key"], []);
    const redacted = redactTrafficCall(detector, call({
      request: { text: '{"api_key":"sk-live","ok":true}', encoding: "utf8" },
      attributes: { authorization: "Bearer hunter2" },
    }));
    expect(JSON.stringify(redacted)).not.toContain("sk-live");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(redacted.attributes.authorization).toBe(REDACTED_VALUE);
    expect(stripTrafficBodies(redacted).request).toBeUndefined();
    expect(stripTrafficBodies(redacted).response).toBeUndefined();
  });

  test("redacts secrets inside base64 data, including gRPC-JSON frames", () => {
    const detector = new Detector(["api_key"], []);
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig";
    const binary = httpTrafficPayload(Buffer.concat([Buffer.from([0x00]), Buffer.from(jwt)]), "application/octet-stream", {});
    expect(binary.encoding).toBe("base64");
    const redactedHttp = redactTrafficCall(detector, call({ request: binary }));
    expect(redactedHttp.request?.data).toBeDefined();
    const decodedHttp = Buffer.from(redactedHttp.request?.data ?? "", "base64").toString("latin1");
    expect(decodedHttp).not.toContain(jwt);
    expect(decodedHttp).toContain(REDACTED_VALUE);

    const frames = grpcFrame('{"api_key":"sk-live","ok":true}');
    const grpc = grpcTrafficPayload(frames, {});
    const redactedGrpc = redactTrafficCall(detector, call({ transport: "grpc", request: grpc }));
    expect(JSON.stringify(redactedGrpc.request?.text)).not.toContain("sk-live");
    const decodedGrpc = Buffer.from(redactedGrpc.request?.data ?? "", "base64").toString("utf8");
    expect(decodedGrpc).not.toContain("sk-live");
    expect(decodedGrpc).toContain(REDACTED_VALUE);
  });

  test("pretty-prints JSON HTTP bodies and keeps binary as base64", () => {
    const json = httpTrafficPayload(Buffer.from('{"id":1}'), "application/json", {});
    expect(json.text).toContain("\n");
    expect(json.encoding).toBe("utf8");
    const binary = httpTrafficPayload(Buffer.from([0x00, 0x01, 0x02]), "application/octet-stream", {});
    expect(binary.encoding).toBe("base64");
    expect(binary.data).toBe(Buffer.from([0x00, 0x01, 0x02]).toString("base64"));
    expect(httpTrafficPayload(undefined, "application/json", { omitted: true, truncated: true }).omitted).toBe(true);
  });

  test("keeps the gRPC length prefix as base64 and pretty-prints a JSON message", () => {
    const frames = grpcFrame('{"hello":"world"}');
    const payload = grpcTrafficPayload(frames, { truncated: true });
    expect(payload.contentType).toBe("application/grpc");
    expect(payload.encoding).toBe("base64");
    expect(payload.data).toBe(frames.toString("base64"));
    expect(payload.text).toContain('"hello"');
    expect(payload.truncated).toBe(true);
    expect(prettyGrpcMessage(frames)).toContain("world");
    expect(prettyGrpcMessage(Buffer.from([0, 0, 0, 0, 1, 0xff]))).toBeUndefined();
  });

  test("decodes gRPC request and response JSON and protobuf on both sides", () => {
    const jsonReq = grpcFrame('{"id":1}');
    const jsonRes = grpcFrame('{"ok":true}');
    const proto = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 2, 0x08, 0x2a]),
    ]);
    const request = grpcTrafficPayload(jsonReq, {});
    const response = grpcTrafficPayload(jsonRes, { contentType: "application/grpc+json" });
    const protoPayload = grpcTrafficPayload(proto, {});
    expect(request.text).toContain('"id"');
    expect(response.text).toContain('"ok"');
    expect(protoPayload.text).toContain('"1"');
    expect(JSON.parse(protoPayload.text ?? "")).toEqual({ "1": 42 });
    expect(request.data).toBe(jsonReq.toString("base64"));
    expect(response.data).toBe(jsonRes.toString("base64"));
  });

  test("pretty-prints multi-frame gRPC streams as a JSON array and marks a dropped trailer truncated", () => {
    const multi = Buffer.concat([grpcFrame('{"a":1}'), grpcFrame('{"b":2}')]);
    const payload = grpcTrafficPayload(multi, {});
    expect(JSON.parse(payload.text ?? "")).toEqual([{ a: 1 }, { b: 2 }]);
    expect(payload.truncated).toBe(false);

    const incomplete = Buffer.concat([multi, Buffer.from([0, 0, 0])]);
    const truncated = grpcTrafficPayload(incomplete, {});
    expect(JSON.parse(truncated.text ?? "")).toEqual([{ a: 1 }, { b: 2 }]);
    expect(truncated.truncated).toBe(true);

    const already = grpcTrafficPayload(multi, { truncated: true });
    expect(already.truncated).toBe(true);
  });
});
