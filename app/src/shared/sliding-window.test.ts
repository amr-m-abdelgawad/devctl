import { describe, expect, test } from "bun:test";
import { SlidingWindowLimiter } from "./sliding-window.ts";

describe("SlidingWindowLimiter", () => {
  test("allows up to the limit inside the window and recovers after it slides", () => {
    let now = 1_000;
    const limiter = new SlidingWindowLimiter(2, 1_000, () => now);
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
    expect(limiter.count("a")).toBe(2);
    now = 2_001;
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.count("a")).toBe(1);
  });

  test("tracks keys independently and reports the hottest", () => {
    const limiter = new SlidingWindowLimiter(5, 1_000, () => 0);
    limiter.tryAcquire("a");
    limiter.tryAcquire("b");
    limiter.tryAcquire("b");
    expect(limiter.hottest()).toEqual({ key: "b", count: 2 });
  });
});
