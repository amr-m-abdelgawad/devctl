import { describe, expect, test } from "bun:test";
import { logRecord } from "../../../domain/logs/record.ts";
import { GAP_FILL_PAGE, LogGapTracker, mergeGapPage } from "./log-gaps.ts";

const rows = (...seqs: number[]) => seqs.map((seq) => logRecord({ seq, service: "api", message: `m${seq}`, timestamp: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z` }));

describe("log gap tracker", () => {
  test("a seq jump opens a gap and the newest page of the newest gap is filled first", () => {
    const gaps = new LogGapTracker(50_000);
    expect(gaps.observe(rows(1, 2, 3))).toBe(false);
    expect(gaps.observe(rows(10, 11))).toBe(true);
    expect(gaps.observe(rows(2_000))).toBe(true);
    expect(gaps.next(undefined)).toEqual({ from: 1_999 - GAP_FILL_PAGE + 1, to: 1_999 });
    gaps.remove({ from: 12, to: 1_999 });
    expect(gaps.next(undefined)).toEqual({ from: 4, to: 9 });
    gaps.remove({ from: 4, to: 9 });
    expect(gaps.pending).toBe(false);
  });

  test("a record arriving late settles its own seq only", () => {
    const gaps = new LogGapTracker(50_000);
    gaps.observe(rows(1, 10));
    gaps.observe(rows(5));
    expect(gaps.next(undefined)).toEqual({ from: 6, to: 9 });
    gaps.remove({ from: 6, to: 9 });
    expect(gaps.next(undefined)).toEqual({ from: 2, to: 4 });
  });

  test("gaps the view can no longer reach are dropped", () => {
    const gaps = new LogGapTracker(100);
    gaps.observe(rows(1, 50, 1_000));
    expect(gaps.next(undefined)).toEqual({ from: 901, to: 999 });
    gaps.remove({ from: 901, to: 999 });
    expect(gaps.pending).toBe(false);

    const trimmed = new LogGapTracker(50_000);
    trimmed.observe(rows(1, 50, 100));
    expect(trimmed.next(60)).toEqual({ from: 60, to: 99 });
    trimmed.remove({ from: 60, to: 99 });
    expect(trimmed.next(60)).toBeUndefined();
  });
});

describe("settling a fetched gap page", () => {
  const range = { from: 101, to: 200 };
  const pageOf = (from: number, to: number, hasPrev: boolean) => ({ events: rows(...Array.from({ length: to - from + 1 }, (_, i) => to - i)), hasPrev });

  function tracker(): LogGapTracker {
    const gaps = new LogGapTracker(50_000);
    gaps.observe(rows(100, 201));
    return gaps;
  }

  test("a full page settles the range and filling goes on", () => {
    const gaps = tracker();
    expect(gaps.settle(range, pageOf(101, 200, true))).toBe(true);
    expect(gaps.pending).toBe(false);
  });

  test("a page a byte budget cut short settles only the part it reached", () => {
    const gaps = tracker();
    expect(gaps.settle(range, pageOf(161, 200, true))).toBe(true);
    expect(gaps.next(undefined)).toEqual({ from: 101, to: 160 });
  });

  test("a short page with nothing older clears every gap", () => {
    const gaps = tracker();
    gaps.observe(rows(300));
    expect(gaps.settle(range, pageOf(161, 200, false))).toBe(false);
    expect(gaps.pending).toBe(false);
  });

  test("an empty page keeps the gap and stops this round", () => {
    const gaps = tracker();
    expect(gaps.settle(range, { events: [], hasPrev: true })).toBe(false);
    expect(gaps.next(undefined)).toEqual(range);
  });
});

describe("merging a gap page", () => {
  test("inserts fetched records in seq order and keeps what the view already holds", () => {
    const current = rows(1, 2, 9, 10);
    const held = current[2]!;
    const merged = mergeGapPage(current, rows(3, 4, 9), "", 100);
    expect(merged.map((row) => row.seq)).toEqual([1, 2, 3, 4, 9, 10]);
    expect(merged[4]).toBe(held);
  });

  test("respects the view's since boundary and its record cap", () => {
    const current = rows(20, 30);
    const merged = mergeGapPage(current, rows(5, 25), "2026-01-01T00:00:10.000Z", 2);
    expect(merged.map((row) => row.seq)).toEqual([25, 30]);
  });
});
