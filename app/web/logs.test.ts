import { describe, expect, test } from "bun:test";
import {
  appendFollowEvents,
  countNewerThan,
  encodeLogsQuery,
  exportFilename,
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
  normalizeDoctorReport,
  normalizeFacets,
  normalizeLogsPayload,
  prependOlderPage,
  rowOffsets,
  sessionIdsFrom,
  visibleIndexRange,
  filterLogRows,
  isSystemLog,
  logIdentity,
  logWrapLabel,
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
    expect(nextLogFollowAction({
      follow: true,
      armed: true,
      atBottom: false,
      scrolledUp: true,
      contentGrew: false,
      contentShrunk: false,
    }).action).toBe("pin");
    expect(nextLogFollowAction({
      follow: true,
      armed: true,
      atBottom: false,
      scrolledUp: false,
      contentGrew: true,
      contentShrunk: false,
    }).action).toBe("snap");
  });

  test("countNewerThan uses seq as identity", () => {
    expect(countNewerThan([ev(1), ev(2), ev(5)], 2)).toBe(1);
    expect(countNewerThan([ev(1)], undefined)).toBe(0);
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
  });

  test("wrap cycles clip → wrap selected → wrap all", () => {
    expect(nextLogWrapMode("clip")).toBe("focus");
    expect(nextLogWrapMode("focus")).toBe("all");
    expect(nextLogWrapMode("all")).toBe("clip");
    expect(logWrapLabel("focus")).toBe("wrap selected");
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
    expect(INITIAL_LOG_PAGE_LIMIT).toBe(500);
  });

  test("exportFilename falls back to jsonl", () => {
    expect(exportFilename('attachment; filename="logs.jsonl"')).toBe("logs.jsonl");
    expect(exportFilename(null)).toBe("devctl-logs.jsonl");
  });

  test("normalizeDoctorReport keeps port holders without implying a kill action", () => {
    const report = normalizeDoctorReport({
      issues: 1,
      checks: [{
        name: "port 8080",
        severity: "warn",
        message: "in use",
        hint: "free the leftover",
        action: { kind: "free-port", holder: { port: 8080, pid: 12, command: "node" } },
      }],
    });
    expect(report.issues).toBe(1);
    expect(report.checks[0]?.action?.holder).toEqual({ port: 8080, pid: 12, command: "node" });
  });
});
