import { describe, expect, test } from "bun:test";
import { eventLoopStalled, watchdogTickAdvanced } from "./event-loop-watchdog.ts";

describe("event loop watchdog", () => {
  test("a stall is many worker ticks without a main-thread beat", () => {
    expect(eventLoopStalled(19)).toBe(false);
    expect(eventLoopStalled(20)).toBe(true);
  });

  test("a burst of callbacks after resume counts as one tick", () => {
    expect(watchdogTickAdvanced(0)).toBe(false);
    expect(watchdogTickAdvanced(100)).toBe(false);
    expect(watchdogTickAdvanced(500)).toBe(true);
    expect(watchdogTickAdvanced(60_000)).toBe(true);
  });
});
