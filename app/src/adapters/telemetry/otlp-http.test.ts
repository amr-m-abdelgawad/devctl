import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import { LogManager } from "../storage/logs.ts";
import { SpanManager } from "../storage/spans.ts";
import { OtlpHttpServer } from "./otlp-http.ts";
import { logMessage } from "../../domain/logs/logs.ts";

describe("OTLP/HTTP+JSON receiver", () => {
  test("maps golden log and trace payloads onto records and spans", async () => {
    const logs = new LogManager(100, undefined, new Detector([], []), false, "/tmp", "otlp", 0, 0);
    const spans = new SpanManager(100);
    const server = new OtlpHttpServer({ host: "127.0.0.1", port: 0, logs: {
      append: (event) => {
        logs.append(event);
      },
      query: async (filter) => logs.query(filter),
      queryPage: async (filter, page) => logs.queryPage(filter, page),
      queryFacets: async (filter) => logs.queryFacets(filter),
      snapshot: () => logs.snapshot(),
      exportTo: async (path, filter) => logs.exportTo(path, filter),
      setParsers: (parsers) => logs.setParsers(parsers),
      setServiceLogs: () => undefined,
      setSecrets: () => undefined,
      close: () => logs.close(),
    }, spans });
    await server.start();
    const base = `http://127.0.0.1:${server.listenPort()}`;
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const spanId = "bbbbbbbbbbbbbbbb";
    const logsRes = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeLogs: [{
            scope: { name: "test" },
            logRecords: [{
              timeUnixNano: "1000",
              severityNumber: 9,
              body: { stringValue: "hello otlp" },
              attributes: [{ key: "http.method", value: { stringValue: "GET" } }],
              traceId,
              spanId,
            }],
          }],
        }],
      }),
    });
    expect(logsRes.status).toBe(200);
    const tracesRes = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeSpans: [{
            spans: [{
              traceId,
              spanId,
              name: "GET /",
              kind: 2,
              startTimeUnixNano: "1",
              endTimeUnixNano: "2",
              status: { code: 1 },
            }],
          }],
        }],
      }),
    });
    expect(tracesRes.status).toBe(200);
    const events = logs.query({});
    expect(logMessage(events[0]!)).toBe("hello otlp");
    expect(events[0]?.source).toBe("otlp");
    expect(events[0]?.traceId).toBe(traceId);
    expect(events[0]?.attributes["http.method"]).toBe("GET");
    const tree = spans.getTrace(traceId);
    expect(tree.spans).toHaveLength(1);
    expect(tree.spans[0]?.name).toBe("GET /");
    expect(tree.spans[0]?.kind).toBe("server");
    await server.stop();
  });

  test("listen errors include EADDRINUSE when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = blocker.address();
    if (!addr || typeof addr === "string") {
      blocker.close();
      throw new Error("expected a TCP listen address");
    }
    const logs = new LogManager(100, undefined, new Detector([], []), false, "/tmp", "otlp", 0, 0);
    const spans = new SpanManager(100);
    const server = new OtlpHttpServer({
      host: "127.0.0.1",
      port: addr.port,
      logs: {
        append: (event) => {
          logs.append(event);
        },
        query: async (filter) => logs.query(filter),
        queryPage: async (filter, page) => logs.queryPage(filter, page),
        queryFacets: async (filter) => logs.queryFacets(filter),
        snapshot: () => logs.snapshot(),
        exportTo: async (path, filter) => logs.exportTo(path, filter),
        setParsers: (parsers) => logs.setParsers(parsers),
        setServiceLogs: () => undefined,
        setSecrets: () => undefined,
        close: () => logs.close(),
      },
      spans,
    });
    try {
      await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

// Serialized by the official opentelemetry-proto Python classes (1.37.0); see
// domain/telemetry/otlp-proto.test.ts for the decoded content.
const TRACE_PROTO = Buffer.from("0acd020a170a150a0c736572766963652e6e616d6512050a0361706912b1020a0c0a0570726f62651203312e3012a0020a100af7651916cd43dd8448eb211c80319c1208b7ad6b7169203331220800f067aa0ba902b72a0a474554202f7573657273300239006c0a591a9f681841801ef1671a9f68184a170a10687474702e7374617475735f636f646512031894034a140a057265747279120b18fdffffffffffffffff014a120a05726174696f120921000000000000e03f4a0c0a06636163686564120210014a130a0474616773120b2a090a030a01610a0218024a160a066e6573746564120c320a0a080a016b12030a01764a0c0a04626c6f6212043a0201025a1f09004d005f1a9f6818120572657472791a0d0a07617474656d7074120218016a1c0a100af7651916cd43dd8448eb211c80319c120800f067aa0ba902b77a0d12096e6f7420666f756e641802", "hex");
const LOGS_PROTO = Buffer.from("0a8a010a170a150a0c736572766963652e6e616d6512050a03617069126f0a070a0570726f6265126409006c0a591a9f6818100d1a045741524e2a120a106469736b20616c6d6f73742066756c6c32130a046469736b120b0a092f6465762f7364613145010000004a100af7651916cd43dd8448eb211c80319c5208b7ad6b716920333159016c0a591a9f6818", "hex");

async function startReceiver(): Promise<{ base: string; logs: LogManager; spans: SpanManager; stop: () => Promise<void> }> {
  const logs = new LogManager(100, undefined, new Detector([], []), false, "/tmp", "otlp", 0, 0);
  const spans = new SpanManager(100);
  const server = new OtlpHttpServer({ host: "127.0.0.1", port: 0, spans, logs: {
    append: (event) => {
      logs.append(event);
    },
    query: async (filter) => logs.query(filter),
    queryPage: async (filter, page) => logs.queryPage(filter, page),
    queryFacets: async (filter) => logs.queryFacets(filter),
    snapshot: () => logs.snapshot(),
    exportTo: async (path, filter) => logs.exportTo(path, filter),
    setParsers: (parsers) => logs.setParsers(parsers),
    setServiceLogs: () => undefined,
    setSecrets: () => undefined,
    close: () => logs.close(),
  } });
  await server.start();
  return { base: `http://127.0.0.1:${server.listenPort()}`, logs, spans, stop: () => server.stop() };
}

describe("OTLP/HTTP protobuf and gzip", () => {
  test("ingests protobuf traces and answers with an empty protobuf response", async () => {
    const rx = await startReceiver();
    try {
      const res = await fetch(`${rx.base}/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: TRACE_PROTO });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/x-protobuf");
      expect((await res.arrayBuffer()).byteLength).toBe(0);
      const tree = rx.spans.getTrace("0af7651916cd43dd8448eb211c80319c");
      expect(tree.spans.map((span) => span.name)).toEqual(["GET /users"]);
    } finally {
      await rx.stop();
    }
  });

  test("ingests gzip-compressed protobuf logs", async () => {
    const rx = await startReceiver();
    try {
      const res = await fetch(`${rx.base}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" },
        body: gzipSync(LOGS_PROTO),
      });
      expect(res.status).toBe(200);
      const events = rx.logs.query({});
      expect(events.map((event) => logMessage(event))).toEqual(["disk almost full"]);
      expect(events[0]?.service).toBe("api");
    } finally {
      await rx.stop();
    }
  });

  test("gzip JSON and a content type with parameters still work", async () => {
    const rx = await startReceiver();
    try {
      const body = gzipSync(JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "zipped json" } }] }] }] }));
      const res = await fetch(`${rx.base}/v1/logs`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip" }, body });
      expect(res.status).toBe(200);
      expect(rx.logs.query({}).map((event) => logMessage(event))).toEqual(["zipped json"]);
    } finally {
      await rx.stop();
    }
  });

  test("unsupported content types and encodings get 415 naming what is accepted", async () => {
    const rx = await startReceiver();
    try {
      const wrongType = await fetch(`${rx.base}/v1/traces`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
      expect(wrongType.status).toBe(415);
      expect(await wrongType.json()).toEqual({ error: "unsupported content type; send application/json or application/x-protobuf" });
      const wrongEncoding = await fetch(`${rx.base}/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf", "content-encoding": "br" }, body: TRACE_PROTO });
      expect(wrongEncoding.status).toBe(415);
    } finally {
      await rx.stop();
    }
  });

  test("malformed protobuf and gzip bodies get 400", async () => {
    const rx = await startReceiver();
    try {
      const badProto = await fetch(`${rx.base}/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: TRACE_PROTO.subarray(0, 40) });
      expect(badProto.status).toBe(400);
      expect(await badProto.json()).toEqual({ error: "invalid protobuf" });
      const badGzip = await fetch(`${rx.base}/v1/logs`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "not gzip" });
      expect(badGzip.status).toBe(400);
      expect(rx.spans.getTrace("0af7651916cd43dd8448eb211c80319c").spans).toHaveLength(0);
    } finally {
      await rx.stop();
    }
  });

  test("a gzip bomb over the body limit gets 413", async () => {
    const rx = await startReceiver();
    try {
      const res = await fetch(`${rx.base}/v1/logs`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20)) });
      expect(res.status).toBe(413);
    } finally {
      await rx.stop();
    }
  });
});
