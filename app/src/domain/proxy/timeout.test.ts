import { describe, expect, test } from "bun:test";
import { deadlineExpired, idleExpired, nextIdleFireMs, nextTotalFireMs, routeTimeouts, timeoutMs } from "./timeout.ts";

describe("route timeout math", () => {
  test("0 / omitted / missing block is unlimited", () => {
    expect(timeoutMs(undefined)).toBeUndefined();
    expect(timeoutMs(0)).toBeUndefined();
    expect(routeTimeouts(undefined)).toEqual({ idleMs: undefined, totalMs: undefined });
    expect(routeTimeouts({})).toEqual({ idleMs: undefined, totalMs: undefined });
    expect(routeTimeouts({ idle_ms: 0, total_ms: 0 })).toEqual({ idleMs: undefined, totalMs: undefined });
  });

  test("positive values are active deadlines", () => {
    expect(timeoutMs(50)).toBe(50);
    expect(routeTimeouts({ idle_ms: 120000, total_ms: 300000 })).toEqual({ idleMs: 120000, totalMs: 300000 });
  });

  test("deadlineExpired / nextTotalFireMs use the start instant", () => {
    expect(deadlineExpired(1000, 900, undefined)).toBe(false);
    expect(deadlineExpired(1000, 900, 0)).toBe(false);
    expect(deadlineExpired(949, 900, 50)).toBe(false);
    expect(deadlineExpired(950, 900, 50)).toBe(true);
    expect(nextTotalFireMs(920, 900, 50)).toBe(30);
    expect(nextTotalFireMs(960, 900, 50)).toBe(0);
    expect(nextTotalFireMs(920, 900, 0)).toBeUndefined();
  });

  test("idleExpired / nextIdleFireMs use last activity", () => {
    expect(idleExpired(1000, 960, undefined)).toBe(false);
    expect(idleExpired(1000, 960, 50)).toBe(false);
    expect(idleExpired(1010, 960, 50)).toBe(true);
    expect(nextIdleFireMs(980, 960, 50)).toBe(30);
    expect(nextIdleFireMs(1020, 960, 50)).toBe(0);
    expect(nextIdleFireMs(980, 960, undefined)).toBeUndefined();
  });
});
