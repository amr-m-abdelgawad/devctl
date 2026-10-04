// Golden fixtures for the ingest oracle: timed read sequences, each run
// through main's line source and append path and through this branch's
// pipeline. Times are milliseconds after FIXTURE_EPOCH_MS; a `chunk` is one
// read of a service stream, an `end` is its end of stream, and an `append` is
// a structured record written directly (the proxy's access records).
//
// Every intended difference from main is declared on its fixture with the
// reason. The test fails if an undeclared difference appears or a declared
// one stops happening, so none of them can drift in silently.
import type { LogIngest } from "../../src/domain/logs/types.ts";
import { recordAt, summarize, type FixtureEvent, type IngestFixture, type IntendedDifference, type StreamRef } from "./ingest-harness.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

function chunks(ref: StreamRef, text: string | Uint8Array, size: number, startAt: number, stepMs: number): FixtureEvent[] {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const out: FixtureEvent[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += size, index += 1) {
    out.push({ at: startAt + index * stepMs, chunk: { ...ref, bytes: bytes.subarray(offset, Math.min(bytes.length, offset + size)) } });
  }
  return out;
}

const API: StreamRef = { service: "api", stream: "stdout", pid: 4101 };
const WEB: StreamRef = { service: "web", stream: "stderr", pid: 4202 };
const WIN: StreamRef = { service: "win", stream: "stdout", pid: 4303 };
const BLOB: StreamRef = { service: "blob", stream: "stdout", pid: 4404 };
const BLOB_TAIL: StreamRef = { service: "blob-tail", stream: "stdout", pid: 4505 };
const ZH: StreamRef = { service: "zh", stream: "stdout", pid: 4606 };
const SVC: StreamRef = { service: "svc", stream: "stdout", pid: 4707 };
const HOP: StreamRef = { service: "api", stream: "stdout", pid: 4808 };
const UV: StreamRef = { service: "uv", stream: "stdout", pid: 4910 };
const MIX_OUT: StreamRef = { service: "mix", stream: "stdout", pid: 5011 };
const MIX_ERR: StreamRef = { service: "mix", stream: "stderr", pid: 5011 };
const TAIL: StreamRef = { service: "tail", stream: "stdout", pid: 5112 };
const JAVA: StreamRef = { service: "java", stream: "stdout", pid: 5213 };

function proxyRecord(message: string, requestId: string): Omit<LogIngest, "timestamp"> {
  return { service: "proxy", source: "proxy", level: "INFO", message, pid: 0, request_id: requestId };
}

/** Declares that fields of one record differ from main, as `[main's value, this branch's value]`. */
function differs(lane: string, index: number, reason: string, fields: Record<string, [unknown, unknown]>): IntendedDifference[] {
  return Object.entries(fields).map(([field, [oracle, current]]) => ({ lane, index, field, oracle: summarize(oracle), current: summarize(current), reason }));
}

/** Declares a record main stored and this branch does not (or the reverse, with `undefined` on the other side). */
function onlyIn(lane: string, index: number, reason: string, oracle: [string, number] | undefined, current: [string, number] | undefined): IntendedDifference {
  return { lane, index, field: "record", oracle: oracle ? recordAt(...oracle) : "<absent>", current: current ? recordAt(...current) : "<absent>", reason };
}

/** Both of a record's time fields, at `t+oracleAt` in main and `t+currentAt` here. */
function readTime(oracleAt: number, currentAt: number): Record<string, [unknown, unknown]> {
  return { timestamp: [`t+${oracleAt}`, `t+${currentAt}`], timeUnixNano: [`t+${oracleAt}`, `t+${currentAt}`] };
}

// Why this branch stores something other than main did. Each is a deliberate
// change of the P0 ingest rewrite, not drift.
const EOF_READ_TIME =
  "The last line of a stream that ends without a newline is stamped with the read time of its bytes, like every other line. main stamped it when its pump saw end of stream.";
const EOF_CR =
  "A trailing CR is stripped from the last unterminated line too, as from every other line. main's pump emitted its end-of-stream leftover without stripping it.";
const CAP_READ_TIME =
  "A line longer than the 48 KiB split cap is emitted, truncated to 16 Ki characters, when the cap is reached, so it carries the read time of the read that crossed the cap. main buffered up to 1 MiB and emitted at the newline or at the 1 MiB force-break, truncating afterwards.";
const CAP_REST =
  "The rest of a line past the cap is skipped through its newline, so one long line is one record. main force-broke at 1 MiB and stored the rest of the same line as a record of its own.";
const CAP_WHOLE_CODE_POINT =
  "The 16 Ki character cap keeps whole code points: an emoji whose surrogate pair straddles the cap is dropped whole. main sliced at 16384 UTF-16 units and stored a lone high surrogate.";

const CJK_LINE = `${"你".repeat(20_000)}\n`;
// 16383 units, then a surrogate pair that straddles the 16 Ki cap.
const SURROGATE_LINE = `${"a".repeat(16_383)}😀tail\n`;
const BIG_JSON = `{"level":"warn","msg":"big","blob":"${"z".repeat(70_000)}"}\n`;

export const FIXTURES: IngestFixture[] = [
  {
    name: "python traceback split across reads",
    covers: "a traceback folded across a 30 ms gap, and split by a 120 ms gap",
    events: [
      { at: 0, chunk: { ...API, bytes: "INFO booting\nTraceback (most recent call last):\n  File \"/srv/app.py\", line 12, in <module>\n" } },
      { at: 30, chunk: { ...API, bytes: "    main()\n  File \"/srv/app.py\", line 8, in main\n    raise ValueError(\"bad\")\nValueError: bad\n" } },
      { at: 200, chunk: { ...API, bytes: "INFO retrying\nTraceback (most recent call last):\n  File \"/srv/job.py\", line 3, in run\n" } },
      { at: 320, chunk: { ...API, bytes: "KeyError: 'missing'\nINFO done\n" } },
      { at: 450, end: API },
    ],
  },
  {
    name: "node stack split mid-line",
    covers: "`multiline.continuation` folding an Error with `at` frames, one frame cut across two reads",
    logs: { web: { stdout: true, stderr: true, multiline: { continuation: "^\\s+at " } } },
    events: [
      { at: 0, chunk: { ...WEB, bytes: "Error: boom\n    at handler (/srv/web/index.js:10:5)\n    at Layer.hand" } },
      { at: 12, chunk: { ...WEB, bytes: "le (/srv/web/node_modules/express/lib/router/layer.js:95:5)\n    at next (/srv/web/node_modules/express/lib/router/route.js:137:13)\nGET /health 200\n" } },
      { at: 60, chunk: { ...WEB, bytes: "TypeError: x is not a function\n    at run (/srv/web/job.js:1:1)\n" } },
      { at: 300, end: WEB },
    ],
  },
  {
    name: "multiline start pattern and max_lines",
    covers: "`multiline.start` folding a Java stack, cut by `max_lines`",
    logs: { java: { stdout: true, stderr: true, multiline: { start: "^\\d{4}-\\d{2}-\\d{2} ", max_lines: 3 } } },
    events: [
      { at: 0, chunk: { ...JAVA, bytes: "2026-09-28 ERROR failed\n\tat com.a.B(B.java:1)\n\tat com.c.D(D.java:2)\n\tat com.e.F(F.java:3)\n\tat com.g.H(H.java:4)\n2026-09-28 INFO next\n" } },
      { at: 200, end: JAVA },
    ],
  },
  {
    name: "CRLF line endings",
    covers: "CRLF split between reads, an empty CRLF line, and a CR-terminated last line with no newline",
    events: [
      { at: 0, chunk: { ...WIN, bytes: "alpha\r\nbeta\r" } },
      { at: 5, chunk: { ...WIN, bytes: "\ngamma\r\n\r\ndelta\r\n" } },
      { at: 10, chunk: { ...WIN, bytes: "last\r" } },
      { at: 40, end: WIN },
    ],
    intended: [
      ...differs("win/stdout/stdout", 5, EOF_CR, { body: ["last\r", "last"], raw: ["last\r", "last"] }),
      ...differs("win/stdout/stdout", 5, EOF_READ_TIME, readTime(40, 10)),
    ],
  },
  {
    name: "1 MiB line with no newline",
    covers: "a 1 MiB line that ends at end of stream, read 64 KiB at a time",
    events: [
      ...chunks(BLOB, "x".repeat(MIB), 64 * KIB, 0, 1),
      { at: 50, end: BLOB },
    ],
    intended: differs("blob/stdout/stdout", 0, CAP_READ_TIME, readTime(15, 0)),
  },
  {
    name: "1 MiB line then more text",
    covers: "a line longer than 1 MiB, then the rest of it and one more line",
    events: [
      ...chunks(BLOB_TAIL, "y".repeat(MIB), 64 * KIB, 0, 1),
      { at: 16, chunk: { ...BLOB_TAIL, bytes: "-rest-of-the-long-line\nnext line\n" } },
      { at: 60, end: BLOB_TAIL },
    ],
    intended: [
      ...differs("blob-tail/stdout/stdout", 0, CAP_READ_TIME, readTime(15, 0)),
      // The rest of the long line is main's record 1, so main's "next line" is record 2 and this branch's is record 1.
      ...differs("blob-tail/stdout/stdout", 1, CAP_REST, { body: ["-rest-of-the-long-line", "next line"], raw: ["-rest-of-the-long-line", "next line"] }),
      onlyIn("blob-tail/stdout/stdout", 2, CAP_REST, ["next line", 16], undefined),
    ],
  },
  {
    name: "CJK text over 16 Ki UTF-16 units",
    covers: "a 20k-character CJK line read in chunks that cut code points, a surrogate pair straddling the 16 Ki cap, and a short CJK line",
    events: [
      ...chunks(ZH, `${CJK_LINE}${SURROGATE_LINE}中文日志 ok\n`, 8_999, 0, 1),
      { at: 50, end: ZH },
    ],
    intended: [
      ...differs("zh/stdout/stdout", 0, CAP_READ_TIME, readTime(6, 5)),
      ...differs("zh/stdout/stdout", 1, CAP_WHOLE_CODE_POINT, {
        body: [`${"a".repeat(16_383)}\ud83d`, "a".repeat(16_383)],
        raw: [`${"a".repeat(16_383)}\ud83d`, "a".repeat(16_383)],
      }),
    ],
  },
  {
    name: "JSON-structured lines",
    covers: "JSON records with level, message, request and trace ids, and one 70 KiB JSON line",
    events: [
      { at: 0, chunk: { ...SVC, bytes: "{\"level\":\"info\",\"msg\":\"user created\",\"request_id\":\"req-77\",\"user\":{\"id\":7}}\n{\"severity\":\"ERROR\",\"message\":\"db down\",\"trace_id\":\"4bf92f3577b34da6a3ce929d0e0e4736\",\"span_id\":\"00f067aa0ba902b7\"}\n" } },
      ...chunks(SVC, BIG_JSON, 32 * KIB, 5, 1),
      { at: 10, chunk: { ...SVC, bytes: "{\"level\":\"debug\",\"msg\":\"after big\"}\n" } },
      { at: 30, end: SVC },
    ],
    intended: differs("svc/stdout/stdout", 2, CAP_READ_TIME, readTime(7, 6)),
  },
  {
    name: "proxy hop re-tags a service line read 20 ms earlier",
    covers: "the proxy access record arrives 20 ms after the service line and re-tags it with its request id",
    events: [
      { at: 0, chunk: { ...HOP, bytes: "GET /api/orders -> handled\n" } },
      { at: 20, append: proxyRecord("GET /api/orders route=api identity= status=200 duration=20ms", "req-1002") },
      { at: 400, end: HOP },
    ],
  },
  {
    name: "proxy hop re-tags a service line read 3 ms earlier",
    covers: "the proxy access record arrives 3 ms after the service line, as it does when the service logs just before it responds",
    // The proxy record is committed before the pipeline's 8 ms drain parses the line it answers, so the pairing
    // has to go by read time. Before event-time pairing this line lost its request id.
    events: [
      { at: 0, chunk: { ...HOP, bytes: "GET /api/users -> handled in 2ms\n" } },
      { at: 3, append: proxyRecord("GET /api/users route=api identity= status=200 duration=3ms", "req-1001") },
      { at: 400, end: HOP },
    ],
  },
  {
    name: "proxy hop tags a service line read after it",
    covers: "the proxy access record comes first and the service line read 10 ms later is tagged on commit",
    events: [
      { at: 0, append: proxyRecord("GET /api/items route=api identity= status=200 duration=1ms", "req-2001") },
      { at: 10, chunk: { ...HOP, bytes: "GET /api/items served\nsecond line\n" } },
      { at: 200, end: HOP },
    ],
  },
  {
    name: "access-line dedupe",
    covers: "a plain access line dropped after the structured one in the same read, and kept 5 ms later",
    logs: { uv: { stdout: true, stderr: true, dedupe_access_line: true } },
    events: [
      { at: 0, chunk: { ...UV, bytes: "{\"level\":\"info\",\"msg\":\"request\",\"http.method\":\"GET\",\"http.target\":\"/x\",\"http.status_code\":200}\nINFO:     127.0.0.1:5000 - \"GET /x HTTP/1.1\" 200 OK\n" } },
      { at: 50, chunk: { ...UV, bytes: "{\"level\":\"info\",\"msg\":\"request\",\"http.method\":\"GET\",\"http.target\":\"/y\",\"http.status_code\":200}\n" } },
      { at: 55, chunk: { ...UV, bytes: "INFO:     127.0.0.1:5000 - \"GET /y HTTP/1.1\" 200 OK\n" } },
      { at: 100, end: UV },
    ],
  },
  {
    name: "stdout and stderr interleaved",
    covers: "per-stream order when one service writes both streams",
    events: [
      { at: 0, chunk: { ...MIX_OUT, bytes: "out-1\n" } },
      { at: 1, chunk: { ...MIX_ERR, bytes: "err-1\n" } },
      { at: 2, chunk: { ...MIX_OUT, bytes: "out-2\nout-3\n" } },
      { at: 3, chunk: { ...MIX_ERR, bytes: "WARN err-2\n" } },
      { at: 20, end: MIX_OUT },
      { at: 20, end: MIX_ERR },
    ],
  },
  {
    name: "last line without a newline",
    covers: "the last line of a stream that ends without a newline",
    events: [
      { at: 0, chunk: { ...TAIL, bytes: "first\nsecond-no-newline" } },
      { at: 30, end: TAIL },
    ],
    // main emitted this line too (its pump always reached `done`), so only the time differs.
    intended: differs("tail/stdout/stdout", 1, EOF_READ_TIME, readTime(30, 0)),
  },
];
