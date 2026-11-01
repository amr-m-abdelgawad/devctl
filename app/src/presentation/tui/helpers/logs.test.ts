import { describe, expect, test } from "bun:test";
import { logRecord } from "../../../domain/logs/record.ts";
import { filterLogs, logRowKey, prependOlderPage, trimLogBytes, tuiLogBytes, tuiLogCap } from "./logs.ts";

const MIB = 1024 * 1024;

const rows = (from: number, to: number, body = "") =>
  Array.from({ length: to - from + 1 }, (_, i) => logRecord({ seq: from + i, service: "api", message: body || `m${from + i}`, timestamp: "2026-01-01T00:00:00.000Z" }));

describe("filterLogs excludeServices", () => {
  test("hides those services, and an empty list hides nothing", () => {
    const events = ["api", "web", "worker"].map((service, i) => logRecord({ seq: i + 1, service, message: "m" }));
    expect(filterLogs(events, { excludeServices: ["api", "worker"] }).map((ev) => ev.service)).toEqual(["web"]);
    expect(filterLogs(events, { excludeServices: [] })).toHaveLength(3);
  });
});

describe("log row keys", () => {
  test("a new line leaves every shown row its key, so React keeps those rows", () => {
    const record = (seq: number) => ({ seq, timestamp: "2026-10-30T00:00:00Z", service: "api" });
    const shown = [record(10), record(11), record(12)];
    const before = shown.map((event, index) => logRowKey(event, index));
    // The window slides by one: the oldest row leaves, a new one arrives.
    const next = [...shown.slice(1), record(13)];
    const after = next.map((event, index) => logRowKey(event, index));
    expect(after.slice(0, 2)).toEqual(before.slice(1));
    expect(new Set(after).size).toBe(after.length);
  });

  test("a record without a seq is keyed by its place", () => {
    expect(logRowKey({ seq: 0, timestamp: "t", service: "api" }, 4)).toBe("t-api-4");
  });
});

describe("TUI log buffer budget", () => {
  test("the default budget holds the whole default window of typical lines", () => {
    const window = rows(1, 50_000, "x".repeat(200));
    expect(trimLogBytes(window, tuiLogBytes(tuiLogCap(undefined)))).toHaveLength(50_000);
    // The flat 8 MiB the view had before kept only part of it.
    expect(trimLogBytes(window, 8 * MIB).length).toBeLessThan(35_000);
  });

  test("scales with the configured window between 8 and 64 MiB", () => {
    expect(tuiLogCap(0)).toBe(50_000);
    expect(tuiLogCap(1_234)).toBe(1_234);
    expect(tuiLogBytes(1_000)).toBe(8 * MIB);
    expect(tuiLogBytes(50_000)).toBe(50_000 * 1024);
    expect(tuiLogBytes(1_000_000)).toBe(64 * MIB);
  });
});

describe("prependOlderPage at the window's limit", () => {
  test("keeps the page just fetched and drops the newest records past the cap", () => {
    const merged = prependOlderPage(rows(101, 200), rows(51, 100), 100);
    expect(merged.map((row) => row.seq)).toEqual(rows(51, 150).map((row) => row.seq));
  });

  test("drops the newest records past the byte budget", () => {
    const held = rows(11, 20, "x".repeat(100));
    const budget = 15 * (100 + "api".length + 64);
    const merged = prependOlderPage(held, rows(1, 10, "x".repeat(100)), Number.POSITIVE_INFINITY, budget);
    expect(merged.map((row) => row.seq)).toEqual(rows(1, 15).map((row) => row.seq));
  });

  test("under the limits nothing is dropped", () => {
    const merged = prependOlderPage(rows(3, 4), rows(1, 3), 100, 64 * MIB);
    expect(merged.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });
});
