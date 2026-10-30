import { describe, expect, test } from "bun:test";
import { keepPerformanceTimelineEmpty, TIMELINE_CLEAR_MS, type TimelineTimers } from "./performance-timeline.ts";

function manualTimers(): TimelineTimers & { tick: () => void; running: () => boolean; every: () => number } {
  let run: (() => void) | undefined;
  let every = 0;
  return {
    setInterval: (fn, ms) => {
      run = fn;
      every = ms;
      return 1;
    },
    clearInterval: () => {
      run = undefined;
    },
    tick: () => run?.(),
    running: () => run !== undefined,
    every: () => every,
  };
}

describe("keepPerformanceTimelineEmpty", () => {
  test("removes what React's development build measures, on a timer and when it stops", () => {
    const calls: string[] = [];
    const timers = manualTimers();
    const stop = keepPerformanceTimelineEmpty({ clearMeasures: () => calls.push("measures"), clearMarks: () => calls.push("marks") }, timers);
    expect(timers.every()).toBe(TIMELINE_CLEAR_MS);
    expect(calls).toEqual([]);
    timers.tick();
    timers.tick();
    expect(calls).toEqual(["measures", "marks", "measures", "marks"]);
    stop();
    expect(timers.running()).toBe(false);
    expect(calls).toHaveLength(6);
    stop();
    expect(calls).toHaveLength(6);
  });

  test("empties the real timeline", () => {
    const stop = keepPerformanceTimelineEmpty();
    for (let i = 0; i < 100; i++) {
      performance.mark(`render-${i}`);
      performance.measure(`component-${i}`, { start: 0, duration: 1, detail: { track: "Components" } });
    }
    expect(performance.getEntriesByType("measure").length).toBeGreaterThanOrEqual(100);
    stop();
    expect(performance.getEntriesByType("measure")).toEqual([]);
    expect(performance.getEntriesByType("mark")).toEqual([]);
  });
});
