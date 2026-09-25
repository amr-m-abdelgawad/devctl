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

  test("ANSI-wrapped ERROR classifies as ERROR after strip", () => {
    const line = "\x1b[31mERROR\x1b[0m ready";
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe("ERROR ready");
    expect(parsed.raw).toBe(line);
    expect(parsed.severityNumber).toBe(SeverityError);
    expect(parsed.severityText).toBe("ERROR");
  });

  test("Python str(dict) stdout is structured, not raw braces", () => {
    const line =
      "{'email': 'unknown', 'referer_url': 'unknown', 'api_url': 'http://127.0.0.1:17490/v1/health', 'start_time': '2026-09-13 11:39:46', 'end_time': '2026-09-13 11:39:46', 'duration_seconds': 0.0005826950073242188, 'response_status': 200}";
    const parsed = parseJSONLogLine(line);
    expect(parsed).toBeDefined();
    expect(parsed?.body).toBe("http://127.0.0.1:17490/v1/health 200 0.0005826950073242188s");
    expect(parsed?.attributes?.email).toBe("unknown");
    expect(parsed?.attributes?.response_status).toBe(200);
    expect(summary(line)).toBe("http://127.0.0.1:17490/v1/health 200 0.0005826950073242188s");
    expect(structuredBodyLooksLikeBraces(summary(line))).toBe(false);
  });

  test("parseJSONLogLine keeps the original raw line including ANSI", () => {
    const raw = "\x1b[32m{\"level\":\"info\",\"msg\":\"ready\"}\x1b[0m";
    const parsed = parseJSONLogLine(raw);
    expect(parsed?.body).toBe("ready");
    expect(parsed?.raw).toBe(raw);
  });

  test("a logger prefix before a Python dict is stripped and retried", () => {
    const parsed = parseJSONLogLine("INFO:workflows {'event': 'user_login', 'user_id': 'u-9'}");
    expect(parsed?.body).toBe("user_login");
    expect(parsed?.attributes?.user_id).toBe("u-9");
  });

  test("prose before a JSON object stays the body; the object becomes attributes", () => {
    const line = 'upload failed: 400, reason: {"error": "quota exceeded"}';
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe(line);
    expect(parsed.attributes).toEqual({ error: "quota exceeded" });
    expect(parsed.severityNumber).toBe(SeverityError);
    expect(summary(line)).toContain("upload failed: 400, reason:");
  });

  test("prose before a Python dict stays the body; the dict becomes attributes", () => {
    const line = "Retrying request to {'host': 'api', 'attempt': 2}";
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe(line);
    expect(parsed.attributes).toEqual({ host: "api", attempt: 2 });
  });

  test("the object's level and request id win over the prose", () => {
    const parsed = parseLogLine('payment declined {"level":"warn","request_id":"r-1","card":"visa"}');
    expect(parsed.body).toBe('payment declined {"level":"warn","request_id":"r-1","card":"visa"}');
    expect(parsed.severityNumber).toBe(SeverityWarn);
    expect(parsed.request_id).toBe("r-1");
    expect(parsed.attributes?.card).toBe("visa");
  });

  test("a single prose label before an object is not a logger preamble", () => {
    const line = 'reason: {"error":"quota exceeded"}';
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe(line);
    expect(parsed.attributes).toEqual({ error: "quota exceeded" });
  });

  test("a status code before an object is prose, not a timestamp", () => {
    const line = '429: {"error":"rate limited"}';
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe(line);
    expect(parsed.attributes).toEqual({ error: "rate limited" });
  });

  test("ISO, zoned, and epoch timestamps still anchor a preamble", () => {
    for (const line of [
      '2026-09-08T19:23:10.000Z {"msg":"booted"}',
      '2026-09-08T19:23:10+02:00 INFO {"msg":"booted"}',
      '2026/09/08 19:23:10 {"msg":"booted"}',
      '1758830590 {"msg":"booted"}',
    ]) {
      expect(parseJSONLogLine(line)?.body, line).toBe("booted");
    }
  });

  test("the object's message fields stay available as attributes", () => {
    const parsed = parseLogLine('detail follows {"message":"hello","user":1}');
    expect(parsed.body).toBe('detail follows {"message":"hello","user":1}');
    expect(parsed.attributes).toEqual({ message: "hello", user: 1 });
  });

  test("an OTLP object after prose keeps its severity and time", () => {
    const line = 'received OTLP record: {"timeUnixNano":100,"severityNumber":17,"body":"fault"}';
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe(line);
    expect(parsed.severityNumber).toBe(17);
    expect(parsed.timeUnixNano).toBe(100);
    expect(parsed.attributes?.body).toBe("fault");
  });

  test("the prose body keeps the line's surrounding whitespace", () => {
    const line = '  upload failed: {"error":"quota exceeded"}  ';
    expect(parseLogLine(line).body).toBe(line);
  });

  test("text after the object keeps the line as the body", () => {
    const line = '2026-09-08T19:23:10.000Z {"msg":"booted"} in 12ms';
    expect(parseLogLine(line).body).toBe(line);
  });

  test("common logger preambles before JSON are still stripped", () => {
    for (const line of [
      '2026-09-23 12:00:00 INFO app: {"msg":"booted"}',
      '2026-09-23 12:00:00,123 - worker - INFO - {"msg":"booted"}',
      '[main] INFO: {"msg":"booted"}',
      '12:00:00 [pid 42] level=info {"msg":"booted"}',
    ]) {
      expect(parseJSONLogLine(line)?.body, line).toBe("booted");
    }
  });

  test("unparseable braces inside prose stay plain text", () => {
    const line = "template {name} is not valid";
    expect(parseJSONLogLine(line)).toBeUndefined();
    const parsed = parseLogLine(line);
    expect(parsed.body).toBe(line);
    expect(parsed.attributes).toEqual({});
  });

  test("Python dict without HTTP fields renders logfmt, not braces", () => {
    const line = "{'foo': 'bar', 'count': 2}";
    const parsed = parseJSONLogLine(line);
    expect(parsed?.body).toEqual({ foo: "bar", count: 2 });
    expect(summary(line)).toContain("foo=bar");
    expect(summary(line)).not.toBe(line);
    expect(structuredBodyLooksLikeBraces(summary(line))).toBe(false);
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
      "{'email': 'unknown', 'api_url': 'http://127.0.0.1:17490/v1/health', 'response_status': 200}",
      "{'foo': 'bar', 'count': 2}",
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
