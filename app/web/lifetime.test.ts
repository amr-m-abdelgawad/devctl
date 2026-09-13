import { describe, expect, test } from "bun:test";
import { advanceRingCounter, emptyRingCounter, lifetimeTotal, logLifetime } from "./lifetime.ts";

describe("advanceRingCounter", () => {
  test("first poll counts the whole ring, later polls only new ids", () => {
    const first = advanceRingCounter(emptyRingCounter(), ["a", "b"]);
    expect(first.seen).toBe(2);
    const second = advanceRingCounter(first, ["b", "c"]);
    expect(second.seen).toBe(3);
    const third = advanceRingCounter(second, ["b", "c"]);
    expect(third.seen).toBe(3);
  });

  test("skips empty ids", () => {
    expect(advanceRingCounter(emptyRingCounter(), ["", "x"]).seen).toBe(1);
  });
});

describe("lifetimeTotal", () => {
  test("takes the largest finite number", () => {
    expect(lifetimeTotal(100, 250, undefined, Number.NaN)).toBe(250);
    expect(lifetimeTotal()).toBe(0);
  });
});

describe("logLifetime", () => {
  test("prefers seen/seenErrors when the daemon reports them", () => {
    expect(logLifetime({ total: 50_000, errors: 3_000, seen: 80_000, seenErrors: 4_100 })).toEqual({
      total: 80_000,
      errors: 4_100,
    });
  });

  test("falls back to ring occupancy on an older daemon", () => {
    expect(logLifetime({ total: 50_000, errors: 3_000 })).toEqual({ total: 50_000, errors: 3_000 });
  });
});
