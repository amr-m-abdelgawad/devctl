import { describe, expect, test } from "bun:test";
import { logRecord } from "./record.ts";
import { NANOS_PER_MS } from "./types.ts";
import { shouldDropAccessLine } from "./access-line.ts";

const T0 = Date.parse("2026-09-19T00:00:00.000Z") * NANOS_PER_MS;

function structured(opts: { pid: number; offsetMs?: number; method?: string; path?: string; status?: number | string; attrs?: Record<string, string | number> }) {
  return logRecord({
    seq: 1,
    service: "api",
    source: "stdout",
    pid: opts.pid,
    timeUnixNano: T0 + (opts.offsetMs ?? 0) * NANOS_PER_MS,
    body: "",
    attributes: {
      method: opts.method ?? "GET",
      path: opts.path ?? "/health",
      status: opts.status ?? 200,
      ...(opts.attrs ?? {}),
    },
  });
}

function plain(opts: { pid: number; offsetMs?: number; line?: string }) {
  return logRecord({
    seq: 2,
    service: "api",
    source: "stdout",
    pid: opts.pid,
    timeUnixNano: T0 + (opts.offsetMs ?? 0) * NANOS_PER_MS,
    message: opts.line ?? 'INFO:     127.0.0.1:12345 - "GET /health HTTP/1.1" 200 OK',
    body: opts.line ?? 'INFO:     127.0.0.1:12345 - "GET /health HTTP/1.1" 200 OK',
  });
}

describe("shouldDropAccessLine", () => {
  test("drops a plain uvicorn line that repeats the previous structured hop", () => {
    expect(shouldDropAccessLine(structured({ pid: 9 }), plain({ pid: 9 }))).toBe(true);
  });

  test("keeps the pair when timestamps are more than 1ms apart", () => {
    expect(shouldDropAccessLine(structured({ pid: 9 }), plain({ pid: 9, offsetMs: 2 }))).toBe(false);
  });

  test("keeps the pair when pids differ", () => {
    expect(shouldDropAccessLine(structured({ pid: 9 }), plain({ pid: 10 }))).toBe(false);
  });

  test("does not drop a structured JSON follow-up", () => {
    const next = logRecord({
      seq: 2,
      service: "api",
      pid: 9,
      timeUnixNano: T0,
      body: '{"method":"GET","path":"/health","status":200}',
      raw: '{"method":"GET","path":"/health","status":200}',
      attributes: { method: "GET", path: "/health", status: 200 },
    });
    expect(shouldDropAccessLine(structured({ pid: 9 }), next)).toBe(false);
  });

  test("reads http.method / http.target / http.status_code", () => {
    const prev = logRecord({
      seq: 1,
      service: "api",
      pid: 9,
      timeUnixNano: T0,
      attributes: { "http.method": "GET", "http.target": "/ready", "http.status_code": 204 },
    });
    const next = plain({ pid: 9, line: 'INFO:     127.0.0.1:9 - "GET /ready HTTP/1.1" 204 OK' });
    expect(shouldDropAccessLine(prev, next)).toBe(true);
  });

  test("does not drop when method+path+status disagree", () => {
    expect(shouldDropAccessLine(structured({ pid: 9, path: "/other" }), plain({ pid: 9 }))).toBe(false);
  });
});
