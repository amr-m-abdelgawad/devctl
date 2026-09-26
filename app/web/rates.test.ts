import { describe, expect, test } from "bun:test";
import { counterWindowRate, rateInWindow, requestIsFailure } from "./rates.ts";

describe("requestIsFailure", () => {
  test("treats HTTP 4xx/5xx and a proxy error as failures", () => {
    expect(requestIsFailure({ status: 500 })).toBe(true);
    expect(requestIsFailure({ status: 404 })).toBe(true);
    expect(requestIsFailure({ status: 200, error: "upstream reset" })).toBe(true);
    expect(requestIsFailure({ status: 200 })).toBe(false);
    expect(requestIsFailure({ status: 200, error: "" })).toBe(false);
    expect(requestIsFailure({ status: 0 })).toBe(false);
    expect(requestIsFailure({ status: 0, error: "dial failed" })).toBe(true);
  });
});

describe("rateInWindow", () => {
  test("counts timestamps inside the lookback and divides by the window", () => {
    const now = Date.parse("2026-09-26T12:00:10.000Z");
    const stamps = [
      "2026-09-26T12:00:09.000Z",
      "2026-09-26T12:00:01.000Z",
      "2026-09-26T11:59:59.000Z",
    ];
    expect(rateInWindow(stamps, now, 10_000)).toBe(0.2);
  });

  test("ignores unparseable timestamps", () => {
    expect(rateInWindow(["not-a-date"], 1_000, 10_000)).toBe(0);
  });
});

describe("counterWindowRate", () => {
  test("returns 0 until a baseline exists", () => {
    expect(counterWindowRate([], 100, 10, 10)).toBe(0);
  });

  test("uses the latest sample at or before the lookback", () => {
    const history = [
      { t: 80, value: 0 },
      { t: 90, value: 10 },
      { t: 95, value: 20 },
    ];
    expect(counterWindowRate(history, 100, 40, 10)).toBe(3);
  });

  test("falls back to the oldest sample while the window is still filling", () => {
    expect(counterWindowRate([{ t: 98, value: 10 }], 100, 16, 10)).toBe(3);
  });

  test("clamps a counter reset to zero", () => {
    expect(counterWindowRate([{ t: 90, value: 50 }], 100, 0, 10)).toBe(0);
  });

  test("returns 0 when the baseline is not earlier than now", () => {
    expect(counterWindowRate([{ t: 100, value: 1 }], 100, 5, 10)).toBe(0);
  });
});
