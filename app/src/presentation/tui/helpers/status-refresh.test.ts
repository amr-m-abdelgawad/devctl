import { describe, expect, test } from "bun:test";
import { STATUS_COALESCE_MS, STATUS_MIN_GAP_MS, STATUS_PERIOD_MS, StatusRefresher, type RefreshTimers } from "./status-refresh.ts";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: RefreshTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        await settle();
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined || next[1].at > end) {
          break;
        }
        pending.delete(next[0]);
        now = next[1].at;
        next[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function counter() {
  const starts: number[] = [];
  return { starts, refresh: (clock: () => number) => async () => void starts.push(clock()) };
}

describe("StatusRefresher", () => {
  test("an event refreshes status within the coalescing window", async () => {
    const clock = fakeTimers();
    const seen = counter();
    const refresher = new StatusRefresher(seen.refresh(clock.timers.now), clock.timers);
    refresher.start();
    refresher.poke();
    await clock.advance(STATUS_COALESCE_MS - 1);
    expect(seen.starts).toEqual([]);
    await clock.advance(1);
    expect(seen.starts).toEqual([STATUS_COALESCE_MS]);
    refresher.stop();
  });

  test("a flood of events refreshes at most four times a second", async () => {
    const clock = fakeTimers();
    const seen = counter();
    const refresher = new StatusRefresher(seen.refresh(clock.timers.now), clock.timers);
    refresher.start();
    for (let ms = 0; ms < 1_000; ms += 1) {
      refresher.poke();
      await clock.advance(1);
    }
    expect(seen.starts).toEqual([30, 280, 530, 780]);
    for (let index = 1; index < seen.starts.length; index += 1) {
      expect(seen.starts[index]! - seen.starts[index - 1]!).toBeGreaterThanOrEqual(STATUS_MIN_GAP_MS);
    }
    refresher.stop();
  });

  test("status refreshes every two seconds with no events", async () => {
    const clock = fakeTimers();
    const seen = counter();
    const refresher = new StatusRefresher(seen.refresh(clock.timers.now), clock.timers);
    refresher.start();
    await clock.advance(3 * STATUS_PERIOD_MS);
    expect(seen.starts).toEqual([STATUS_PERIOD_MS, 2 * STATUS_PERIOD_MS, 3 * STATUS_PERIOD_MS]);
    refresher.stop();
  });

  test("runs one refresh at a time and once more after a slow one if events came in", async () => {
    const clock = fakeTimers();
    const starts: number[] = [];
    let finish: () => void = () => undefined;
    const refresher = new StatusRefresher(() => {
      starts.push(clock.timers.now());
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }, clock.timers);
    refresher.poke();
    await clock.advance(STATUS_COALESCE_MS);
    refresher.poke();
    refresher.poke();
    await clock.advance(1_000);
    expect(starts).toEqual([30]);
    finish();
    await clock.advance(0);
    expect(starts).toEqual([30, 1_030]);
    refresher.stop();
  });

  test("stop cancels the schedule and a refresh finishing later does not restart it", async () => {
    const clock = fakeTimers();
    const starts: number[] = [];
    let finish: () => void = () => undefined;
    const refresher = new StatusRefresher(() => {
      starts.push(clock.timers.now());
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }, clock.timers);
    refresher.poke();
    await clock.advance(STATUS_COALESCE_MS);
    refresher.poke();
    refresher.stop();
    finish();
    await clock.advance(10 * STATUS_PERIOD_MS);
    expect(starts).toEqual([30]);
    expect(clock.pending()).toBe(0);
  });
});
