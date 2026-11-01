import { laterLogSince } from "./logs.ts";
import { describe, expect, test } from "bun:test";
import {
  appendFollowEvents,
  countNewerThan,
  encodeLogsQuery,
  exportFilename,
  toggleListedService,
  INITIAL_LOG_PAGE_LIMIT,
  liveLogsQuery,
  followPollDelay,
  FOLLOW_HIDDEN_POLL_MS,
  FOLLOW_IDLE_POLL_MS,
  FOLLOW_POLL_MS,
  indexAtOffset,
  mergeLoadedPage,
  nextLogFollowAction,
  nextLogWrapMode,
  nextPinSeq,
  normalizeDoctorReport,
  normalizeFacets,
  normalizeLogsPayload,
  prependOlderPage,
  rowOffsets,
  sessionIdsFrom,
  visibleIndexRange,
  facetLevelCount,
  filterLogRows,
  isGrpcLogRow,
  isHealthCheckRow,
  isSystemLog,
  toggleListedLevel,
  clipLogMessage,
  logIdentity,
  logSearchFinder,
  logWrapLabel,
  logsQueryKey,
  nextLogSelectionIndex,
} from "./logs.ts";
import type { LogRow } from "./types.ts";

function ev(seq: number, extra: Partial<LogRow> = {}): LogRow {
  return {
    timestamp: `2026-01-01T00:00:0${seq}.000Z`,
    service: extra.service ?? "api",
    source: extra.source ?? "stdout",
    severityText: extra.severityText ?? "INFO",
    level: extra.level ?? extra.severityText ?? "INFO",
    message: extra.message ?? `msg-${seq}`,
    seq,
    ...extra,
  };
}

describe("log page merge", () => {
  test("mergeLoadedPage keeps live events newer than the loaded tail", () => {
    expect(mergeLoadedPage([ev(4), ev(5)], [ev(1), ev(2), ev(3)]).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(mergeLoadedPage([ev(3)], [ev(1), ev(2), ev(3)]).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  test("prependOlderPage adds older events without duplicating seq", () => {
    expect(prependOlderPage([ev(3), ev(4)], [ev(1), ev(2), ev(3)]).map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(prependOlderPage([ev(3)], [])).toEqual([ev(3)]);
  });

  test("appendFollowEvents de-dupes by seq and honors the ring cap", () => {
    const merged = appendFollowEvents([ev(1), ev(2)], [ev(2), ev(3)], "", 3);
    expect(merged.map((row) => row.seq)).toEqual([1, 2, 3]);
    const capped = appendFollowEvents([ev(1), ev(2), ev(3)], [ev(4), ev(5)], "", 3);
    expect(capped.map((row) => row.seq)).toEqual([3, 4, 5]);
  });

  test("appendFollowEvents hides events before a client-local since", () => {
    const kept = appendFollowEvents([ev(2)], [ev(1), ev(3)], "2026-01-01T00:00:02.000Z", 50);
    expect(kept.map((row) => row.seq)).toEqual([2, 3]);
  });
});

describe("log windowing", () => {
  test("keyboard selection starts at the first or last record and stays within the loaded window", () => {
    expect(nextLogSelectionIndex(5, -1, 1)).toBe(0);
    expect(nextLogSelectionIndex(5, -1, -1)).toBe(4);
    expect(nextLogSelectionIndex(5, 0, -1)).toBe(0);
    expect(nextLogSelectionIndex(5, 4, 1)).toBe(4);
    expect(nextLogSelectionIndex(5, 2, 1)).toBe(3);
    expect(nextLogSelectionIndex(0, -1, 1)).toBe(-1);
  });
  test("visibleIndexRange overscans around the viewport", () => {
    expect(visibleIndexRange(100, 280, 140, 28, 2)).toEqual({ start: 8, end: 17 });
    expect(visibleIndexRange(0, 0, 100, 28, 2)).toEqual({ start: 0, end: 0 });
  });

  test("indexAtOffset finds the row covering a pixel", () => {
    const offsets = rowOffsets(4, () => 10);
    expect(offsets).toEqual([0, 10, 20, 30, 40]);
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 19)).toBe(1);
    expect(indexAtOffset(offsets, 30)).toBe(3);
  });
});

describe("log follow helpers", () => {
  test("followPollDelay backs off when idle or hidden", () => {
    expect(followPollDelay({ idle: false, hidden: false })).toBe(FOLLOW_POLL_MS);
    expect(followPollDelay({ idle: true, hidden: false })).toBe(FOLLOW_IDLE_POLL_MS);
    expect(followPollDelay({ idle: false, hidden: true })).toBe(FOLLOW_HIDDEN_POLL_MS);
  });

  test("nextLogFollowAction pins on a user scroll-up and snaps on layout growth", () => {
    expect(
      nextLogFollowAction({
        follow: true,
        armed: true,
        atBottom: false,
        scrolledUp: true,
        contentGrew: false,
        contentShrunk: false,
      }).action,
    ).toBe("pin");
    expect(
      nextLogFollowAction({
        follow: true,
        armed: true,
        atBottom: false,
        scrolledUp: false,
        contentGrew: true,
        contentShrunk: false,
      }).action,
    ).toBe("snap");
  });

  test("countNewerThan uses seq as identity", () => {
    expect(countNewerThan([ev(1), ev(2), ev(5)], 2)).toBe(1);
    expect(countNewerThan([ev(1)], undefined)).toBe(0);
  });

  test("a later selection keeps the original pin", () => {
    expect(nextPinSeq(true, undefined, 4)).toBe(4);
    expect(nextPinSeq(false, 4, 9)).toBe(4);
    expect(nextPinSeq(true, 4, 9)).toBe(9);
  });
});

describe("log filters and wrap", () => {
  test("hides system sources and ERROR+ rows", () => {
    const rows = [
      ev(1, { source: "auth", service: "auth", message: "token" }),
      ev(2, { level: "ERROR", severityText: "ERROR", message: "boom" }),
      ev(3, { message: "ok" }),
    ];
    expect(filterLogRows(rows, { showSystem: false }).map((row) => row.seq)).toEqual([2, 3]);
    expect(filterLogRows(rows, { errorOnly: true }).map((row) => row.seq)).toEqual([2]);
    expect(isSystemLog(rows[0]!)).toBe(true);
    const grpc = ev(4, { service: "proxy", source: "proxy", message: "grpc /pkg.Service/Poll route=t grpc-status=0" });
    const http = ev(5, { service: "proxy", source: "proxy", message: "GET /health route=api status=200" });
    expect(isGrpcLogRow(grpc)).toBe(true);
    expect(isGrpcLogRow(http)).toBe(false);
    expect(filterLogRows([grpc, http], { showGrpc: false }).map((row) => row.seq)).toEqual([5]);
    expect(encodeLogsQuery({ hideGrpc: true })).toEqual({ hide_grpc: "true" });
    expect(liveLogsQuery({ showGrpc: false })).toEqual({ hideGrpc: true });
    expect(liveLogsQuery({})).toEqual({});
  });

  test("hides health-check rows and keeps the chosen levels", () => {
    const rows = [
      ev(1, { source: "health", message: "health HEALTHY 200" }),
      ev(2, { level: "INFO", severityText: "INFO", severityNumber: 9, message: "ready" }),
      ev(3, { level: "WARN", severityText: "WARN", severityNumber: 13, message: "slow" }),
      ev(4, { level: "INFO", severityText: "INFO", severityNumber: 9, message: 'INFO:     127.0.0.1:1 - "GET /health HTTP/1.1" 200 OK' }),
      ev(5, {
        source: "proxy",
        level: "INFO",
        severityText: "INFO",
        severityNumber: 9,
        message: "grpc /grpc.health.v1.Health/Watch route=api grpc-status=0",
      }),
    ];
    expect(isHealthCheckRow(rows[0]!)).toBe(true);
    expect(isHealthCheckRow(rows[3]!)).toBe(true);
    expect(filterLogRows(rows, { hideHealth: true, levels: ["INFO", "WARN"] }).map((row) => row.seq)).toEqual([2, 3]);
    expect(filterLogRows(rows, { levels: ["WARN", "ERROR"] }).map((row) => row.seq)).toEqual([3]);
    expect(toggleListedLevel(["WARN"], "error")).toEqual(["WARN", "ERROR"]);
    expect(facetLevelCount({ INFO: 2, WARNING: 1 }, "WARN")).toBe(1);
  });

  test("a folded traceback clips to its first line", () => {
    expect(clipLogMessage("ready")).toBe("ready");
    expect(clipLogMessage("Traceback (most recent call last):\n  File \"a.py\", line 1")).toBe("Traceback (most recent call last):");
    expect(clipLogMessage("a\r\nb")).toBe("a");
    expect(clipLogMessage("a\rb")).toBe("a");
  });

  test("wrap cycles clip → wrap selected → wrap all", () => {
    expect(nextLogWrapMode("clip")).toBe("focus");
    expect(nextLogWrapMode("focus")).toBe("all");
    expect(nextLogWrapMode("all")).toBe("clip");
    expect(logWrapLabel("focus")).toBe("wrap selected");
  });

  test("search spans mark each literal and regex hit", () => {
    expect(logSearchFinder("inv", false)("cache miss for inv-2200")).toEqual([{ start: 15, end: 18 }]);
    expect(logSearchFinder("INV", false)("inv-2200 and inv-3")).toEqual([
      { start: 0, end: 3 },
      { start: 13, end: 16 },
    ]);
    expect(logSearchFinder("inv-\\d+", true)("job inv-12 and inv-3")).toEqual([
      { start: 4, end: 10 },
      { start: 15, end: 20 },
    ]);
    expect(logSearchFinder("(", true)("a(b")).toEqual([{ start: 1, end: 2 }]);
    expect(logSearchFinder("   ", false)("hello")).toEqual([]);
    const starred = logSearchFinder("a*", true)("ba");
    expect(starred.every((span) => span.end > span.start)).toBe(true);
    expect(starred).toContainEqual({ start: 1, end: 2 });
  });

  test("logIdentity prefers seq", () => {
    expect(logIdentity(ev(9))).toBe("seq:9");
  });
});

describe("log payload adapters", () => {
  test("normalizeLogsPayload accepts snake_case and camelCase cursors", () => {
    const snake = normalizeLogsPayload({
      events: [ev(1)],
      next_cursor: "n",
      prev_cursor: "p",
      has_more: true,
      session_changed: true,
    });
    expect(snake.next_cursor).toBe("n");
    expect(snake.prev_cursor).toBe("p");
    expect(snake.session_changed).toBe(true);
    const camel = normalizeLogsPayload({ events: [], nextCursor: "n2", prevCursor: "p2", sessionChanged: true });
    expect(camel.next_cursor).toBe("n2");
    expect(camel.session_changed).toBe(true);
  });

  test("normalizeFacets and session list shapes", () => {
    expect(normalizeFacets({ total: 3, byService: { api: 2 }, by_level: { ERROR: 1 }, bySource: { stdout: 3 } })).toEqual({
      total: 3,
      byService: { api: 2 },
      byLevel: { ERROR: 1 },
      bySource: { stdout: 3 },
    });
    expect(sessionIdsFrom({ sessions: ["a", ""] })).toEqual(["a"]);
    expect(sessionIdsFrom(["b", "c"])).toEqual(["b", "c"]);
  });

  test("encodeLogsQuery omits empty flags and sends cursor paging", () => {
    expect(encodeLogsQuery({ search: "boom", regex: true, limit: INITIAL_LOG_PAGE_LIMIT })).toEqual({
      search: "boom",
      regex: "true",
      limit: "500",
    });
    expect(encodeLogsQuery({ cursor: "p", direction: "backward", limit: INITIAL_LOG_PAGE_LIMIT })).toEqual({
      cursor: "p",
      direction: "backward",
      limit: "500",
    });
    expect(liveLogsQuery({ search: "err", errorOnly: true, regex: true })).toEqual({
      level: "ERROR",
      search: "err",
      regex: true,
    });
    expect(encodeLogsQuery(liveLogsQuery({ levels: ["INFO", "WARN"], hideHealth: true }))).toEqual({
      levels: "INFO,WARN",
      hide_health: "true",
    });
    expect(INITIAL_LOG_PAGE_LIMIT).toBe(500);
  });

  test("exportFilename falls back to jsonl", () => {
    expect(exportFilename('attachment; filename="logs.jsonl"')).toBe("logs.jsonl");
    expect(exportFilename(null)).toBe("devctl-logs.jsonl");
  });

  test("normalizeDoctorReport keeps port holders without implying a kill action", () => {
    const report = normalizeDoctorReport({
      issues: 1,
      checks: [
        {
          name: "port 8080",
          severity: "warn",
          message: "in use",
          hint: "free the leftover",
          action: { kind: "free-port", holder: { port: 8080, pid: 12, command: "node" } },
        },
      ],
    });
    expect(report.issues).toBe(1);
    expect(report.checks[0]?.action?.holder).toEqual({ port: 8080, pid: 12, command: "node" });
  });
});

test("log time bounds stay effective after clear and historical exports retain their session", () => {
  const filterSince = "2026-10-29T10:00:00.000Z";
  const clearSince = "2026-10-29T11:00:00.000Z";
  expect(laterLogSince(filterSince, "")).toBe(filterSince);
  expect(laterLogSince(filterSince, clearSince)).toBe(clearSince);
  expect(laterLogSince(clearSince, filterSince)).toBe(clearSince);
  expect(laterLogSince()).toBeUndefined();
  expect(encodeLogsQuery({ sessionId: "history-session", since: filterSince, until: clearSince })).toEqual({
    session: "history-session",
    since: filterSince,
    until: clearSince,
  });
});

test("correlation and system filters reach server queries and invalidate the paging window", () => {
  const query = {
    hideSystem: true,
    requestId: "req-1",
    traceId: "trace-1",
    attributeKey: "http.method",
    attributeValue: "POST",
    source: "stdout",
    dedupeRequestId: true,
  };
  expect(encodeLogsQuery(query)).toEqual({
    hide_system: "true",
    request_id: "req-1",
    trace_id: "trace-1",
    attribute_key: "http.method",
    attribute_value: "POST",
    source: "stdout",
    dedupe_request_id: "true",
  });
  expect(liveLogsQuery({ showSystem: false })).toEqual({ hideSystem: true });
  for (const key of Object.keys(query)) expect(logsQueryKey(query)).not.toBe(logsQueryKey({ ...query, [key]: undefined }));
});

describe("excluded services", () => {
  test("travel in the query and its key", () => {
    const query = liveLogsQuery({ excludeServices: ["api", "web"] });
    expect(encodeLogsQuery(query).exclude_services).toBe("api,web");
    expect(logsQueryKey(query)).not.toBe(logsQueryKey(liveLogsQuery({})));
    expect(liveLogsQuery({ excludeServices: [] }).excludeServices).toBeUndefined();
  });

  test("leave the rows on screen", () => {
    const rows = ["api", "web"].map((service, index) => ({ seq: index + 1, service, source: "stdout", message: "m", level: "INFO", timestamp: "2026-11-01T00:00:00.000Z" }));
    expect(filterLogRows(rows as never, { excludeServices: ["api"] }).map((row) => row.service)).toEqual(["web"]);
  });

  test("toggle in sorted order, so the same set makes the same query", () => {
    expect(toggleListedService(toggleListedService([], "web"), "api")).toEqual(["api", "web"]);
    expect(toggleListedService(["api", "web"], "api")).toEqual(["web"]);
  });
});
