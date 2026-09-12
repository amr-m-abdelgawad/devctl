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
});
