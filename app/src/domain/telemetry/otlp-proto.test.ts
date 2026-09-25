import { describe, expect, test } from "bun:test";
import { decodeOtlpLogsProto, decodeOtlpTracesProto } from "./otlp-proto.ts";
import { mapOtlpLogs, mapOtlpTraces } from "./otlp.ts";

// Golden bytes serialized by the official opentelemetry-proto Python classes
// (opentelemetry-proto 1.37.0), so decoding is checked against the reference
// encoder rather than against an encoder written for this test.
const TRACE_REQUEST_HEX =
  "0acd020a170a150a0c736572766963652e6e616d6512050a0361706912b1020a0c0a0570726f62651203312e3012a0020a100af7651916cd43dd8448eb211c80319c1208b7ad6b7169203331220800f067aa0ba902b72a0a474554202f7573657273300239006c0a591a9f681841801ef1671a9f68184a170a10687474702e7374617475735f636f646512031894034a140a057265747279120b18fdffffffffffffffff014a120a05726174696f120921000000000000e03f4a0c0a06636163686564120210014a130a0474616773120b2a090a030a01610a0218024a160a066e6573746564120c320a0a080a016b12030a01764a0c0a04626c6f6212043a0201025a1f09004d005f1a9f6818120572657472791a0d0a07617474656d7074120218016a1c0a100af7651916cd43dd8448eb211c80319c120800f067aa0ba902b77a0d12096e6f7420666f756e641802";
const LOGS_REQUEST_HEX =
  "0a8a010a170a150a0c736572766963652e6e616d6512050a03617069126f0a070a0570726f6265126409006c0a591a9f6818100d1a045741524e2a120a106469736b20616c6d6f73742066756c6c32130a046469736b120b0a092f6465762f7364613145010000004a100af7651916cd43dd8448eb211c80319c5208b7ad6b716920333159016c0a591a9f6818";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const PARENT_ID = "00f067aa0ba902b7";

function bytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

describe("OTLP protobuf decode", () => {
  test("decodes an ExportTraceServiceRequest into the OTLP/JSON shape", () => {
    const decoded = decodeOtlpTracesProto(bytes(TRACE_REQUEST_HEX));
    const resourceSpans = decoded.resourceSpans as Array<Record<string, any>>;
    const scopeSpans = resourceSpans[0]?.scopeSpans as Array<Record<string, any>>;
    expect(resourceSpans[0]?.resource).toEqual({ attributes: [{ key: "service.name", value: { stringValue: "api" } }] });
    expect(scopeSpans[0]?.scope).toEqual({ name: "probe", version: "1.0" });
    const span = scopeSpans[0]?.spans[0];
    expect(span).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: PARENT_ID,
      name: "GET /users",
      kind: 2,
      startTimeUnixNano: "1758830590000000000",
      endTimeUnixNano: "1758830590250000000",
      status: { code: 2, message: "not found" },
      links: [{ traceId: TRACE_ID, spanId: PARENT_ID }],
      events: [{ timeUnixNano: "1758830590100000000", name: "retry", attributes: [{ key: "attempt", value: { intValue: "1" } }] }],
    });
    expect(span.attributes).toEqual([
      { key: "http.status_code", value: { intValue: "404" } },
      { key: "retry", value: { intValue: "-3" } },
      { key: "ratio", value: { doubleValue: 0.5 } },
      { key: "cached", value: { boolValue: true } },
      { key: "tags", value: { arrayValue: { values: [{ stringValue: "a" }, { intValue: "2" }] } } },
      { key: "nested", value: { kvlistValue: { values: [{ key: "k", value: { stringValue: "v" } }] } } },
      { key: "blob", value: { bytesValue: "AQI=" } },
    ]);
  });

  test("decoded traces map onto spans the same way JSON does", () => {
    const spans = mapOtlpTraces(decodeOtlpTracesProto(bytes(TRACE_REQUEST_HEX)), "fallback");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: PARENT_ID,
      name: "GET /users",
      startUnixNano: 1758830590000000000,
      attributes: { "http.status_code": 404, retry: -3, ratio: 0.5, cached: true },
    });
    expect(spans[0]?.resource?.["service.name"]).toBe("api");
  });

  test("decodes an ExportLogsServiceRequest and maps it onto a log record", () => {
    const decoded = decodeOtlpLogsProto(bytes(LOGS_REQUEST_HEX));
    const record = ((decoded.resourceLogs as Array<Record<string, any>>)[0]?.scopeLogs[0]?.logRecords[0]) as Record<string, unknown>;
    expect(record).toMatchObject({
      timeUnixNano: "1758830590000000000",
      observedTimeUnixNano: "1758830590000000001",
      severityNumber: 13,
      severityText: "WARN",
      body: { stringValue: "disk almost full" },
      flags: 1,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
    const logs = mapOtlpLogs(decoded, "fallback");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ service: "api", body: "disk almost full", severityText: "WARN", traceId: TRACE_ID, spanId: SPAN_ID, attributes: { disk: "/dev/sda1" } });
  });

  test("an empty request decodes to an empty object", () => {
    expect(decodeOtlpTracesProto(new Uint8Array())).toEqual({});
    expect(mapOtlpLogs(decodeOtlpLogsProto(new Uint8Array()), "x")).toEqual([]);
  });

  test("unknown fields are skipped by wire type", () => {
    // field 99 varint 1, field 98 length-delimited "hi", field 97 fixed32, then resource_spans (empty)
    const withUnknown = bytes("9806019206026869ed0601000000" + "0a00");
    expect(decodeOtlpTracesProto(withUnknown)).toEqual({ resourceSpans: [{}] });
  });

  test("malformed protobuf throws instead of returning partial data", () => {
    const full = bytes(TRACE_REQUEST_HEX);
    expect(() => decodeOtlpTracesProto(full.subarray(0, full.length - 5))).toThrow();
    expect(() => decodeOtlpTracesProto(bytes("0aff"))).toThrow(); // length past the end
    expect(() => decodeOtlpTracesProto(bytes("0b"))).toThrow(); // wire type 3 (start group)
    expect(() => decodeOtlpTracesProto(bytes("08ffffffffffffffffffffff"))).toThrow(); // unterminated varint
    expect(() => decodeOtlpTracesProto(new TextEncoder().encode('{"resourceSpans":[]}'))).toThrow();
  });
});
