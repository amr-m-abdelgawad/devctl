import { describe, expect, test } from "bun:test";
import { formatBodySummary, logRecord } from "./logs.ts";
import { parseJSONLogLine, parseLogLine, structuredBodyLooksLikeBraces } from "./parse.ts";
import { SeverityError, SeverityInfo, SeverityWarn } from "./severity.ts";

function summary(line: string): string {
  const parsed = parseJSONLogLine(line) ?? parseLogLine(line);
  return formatBodySummary(logRecord({
    body: parsed.body,
    attributes: parsed.attributes,
    level: parsed.severityText,
    severityNumber: parsed.severityNumber,
    message: typeof parsed.body === "string" ? parsed.body : undefined,
    raw: parsed.raw,
  }));
}

describe("structured log parse table", () => {
  test("pino JSON uses msg and numeric level", () => {
    const parsed = parseJSONLogLine('{"level":30,"msg":"listening","pid":12}');
    expect(parsed?.body).toBe("listening");
    expect(parsed?.severityNumber).toBe(SeverityInfo);
    expect(parsed?.attributes?.pid).toBe(12);
    expect(structuredBodyLooksLikeBraces(parsed?.body ?? "")).toBe(false);
  });

  test("zap JSON uses msg and string level", () => {
    const parsed = parseJSONLogLine('{"level":"error","ts":1710000000,"msg":"db down","caller":"server.go:90"}');
    expect(parsed?.body).toBe("db down");
    expect(parsed?.severityNumber).toBe(SeverityError);
    expect(parsed?.attributes?.caller).toBe("server.go:90");
  });

  test("logrus JSON uses msg", () => {
    const parsed = parseJSONLogLine('{"time":"2026-09-08T19:23:10Z","level":"warning","msg":"retrying","attempt":3}');
    expect(parsed?.body).toBe("retrying");
    expect(parsed?.severityNumber).toBe(SeverityWarn);
    expect(parsed?.attributes?.attempt).toBe(3);
  });

  test("python structlog JSON uses event as the message", () => {
    const parsed = parseJSONLogLine('{"event":"user_login","level":"info","user_id":"u-9"}');
    expect(parsed?.body).toBe("user_login");
    expect(parsed?.attributes?.user_id).toBe("u-9");
  });

  test("ECS JSON keeps message and extra fields as attributes", () => {
    const parsed = parseJSONLogLine('{"@timestamp":"2026-09-08T19:23:10.000Z","log.level":"info","message":"handled","http":{"request":{"method":"GET"}}}');
    expect(parsed?.body).toBe("handled");
    expect(parsed?.attributes?.http).toEqual({ request: { method: "GET" } });
  });

  test("GELF short_message is the body", () => {
    const parsed = parseJSONLogLine('{"version":"1.1","host":"api","short_message":"disk full","level":3}');
    expect(parsed?.body).toBe("disk full");
    expect(parsed?.severityNumber).toBe(SeverityError);
    expect(parsed?.attributes?.host).toBe("api");
  });

  test("non-standard message key keeps the object structured, never raw braces", () => {
    const line = '{"foo":"bar","count":2}';
    const parsed = parseJSONLogLine(line);
    expect(parsed).toBeDefined();
    expect(parsed?.body).toEqual({ foo: "bar", count: 2 });
    expect(summary(line)).toContain("foo=bar");
    expect(summary(line)).not.toMatch(/foo=bar.*foo=bar/);
    expect(summary(line)).not.toBe(line);
    expect(structuredBodyLooksLikeBraces(summary(line))).toBe(false);
  });

  test("top-level body field is used as the message, not dropped", () => {
    const parsed = parseJSONLogLine('{"body":"hello world","user":1}');
    expect(parsed?.body).toBe("hello world");
    expect(parsed?.attributes?.user).toBe(1);
    expect(parsed?.attributes?.body).toBeUndefined();
    expect(structuredBodyLooksLikeBraces(parsed?.body ?? "")).toBe(false);
  });

  test("leading timestamp prefix before JSON is stripped and retried", () => {
    const parsed = parseJSONLogLine('2026-09-08T19:23:10.000Z {"level":"info","msg":"booted"}');
    expect(parsed?.body).toBe("booted");
    expect(parsed?.severityNumber).toBe(SeverityInfo);
  });

  test("OTLP-JSON keeps attributes, severity number, and ids", () => {
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const spanId = "bbbbbbbbbbbbbbbb";
    const line = JSON.stringify({
      timeUnixNano: "1788902590000000000",
      severityNumber: 17,
      severityText: "ERROR",
      body: { stringValue: "HTTP request processed" },
      attributes: [
        { key: "http.status_code", value: { intValue: 404 } },
        { key: "http.method", value: { stringValue: "GET" } },
      ],
      traceId,
      spanId,
    });
    const parsed = parseJSONLogLine(line);
    expect(parsed?.body).toBe("HTTP request processed");
    expect(parsed?.severityNumber).toBe(SeverityError);
    expect(parsed?.attributes?.["http.status_code"]).toBe(404);
    expect(parsed?.traceId).toBe(traceId);
    expect(parsed?.spanId).toBe(spanId);
  });

  test("plain text keeps the line as body", () => {
    const parsed = parseLogLine("plain text line");
    expect(parsed.body).toBe("plain text line");
    expect(parsed.attributes).toEqual({});
  });

  test("none of the acceptance inputs render as raw braces", () => {
    const lines = [
      '{"level":30,"msg":"listening"}',
      '{"level":"error","msg":"db down"}',
      '{"level":"warning","msg":"retrying"}',
      '{"event":"user_login","level":"info"}',
      '{"message":"handled","ecs.version":"8.11"}',
      '{"short_message":"disk full","level":3}',
      '{"foo":"bar","count":2}',
      '{"body":"hello world","user":1}',
      '2026-09-08T19:23:10.000Z {"msg":"booted"}',
      '{"timeUnixNano":"1","body":{"stringValue":"HTTP request processed"},"attributes":[{"key":"http.method","value":{"stringValue":"GET"}}]}',
      "plain text line",
    ];
    for (const line of lines) {
      const text = summary(line);
      expect(structuredBodyLooksLikeBraces(text), line).toBe(false);
      expect(text.trim().startsWith("{"), line).toBe(false);
    }
  });
});
