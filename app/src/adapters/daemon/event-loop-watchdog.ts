import { clearInterval as clearWatchInterval, setInterval as setWatchInterval } from "node:timers";

export const WATCHDOG_TICK_MS = 1_000;
export const WATCHDOG_STALL_TICKS = 20;
export const WATCHDOG_MIN_TICK_GAP_MS = WATCHDOG_TICK_MS / 2;

// True when the worker has kept ticking and the main thread has not posted
// a beat. Sleep freezes both, so a wall-clock gap is not a stall.
export function eventLoopStalled(ticksSinceBeat: number, stallTicks = WATCHDOG_STALL_TICKS): boolean {
  return ticksSinceBeat >= stallTicks;
}

// A resume can deliver a burst of interval callbacks at once. Those must
// count as a single tick, or waking from sleep looks like a stalled loop.
export function watchdogTickAdvanced(elapsedMs: number, minGapMs = WATCHDOG_MIN_TICK_GAP_MS): boolean {
  return elapsedMs >= minGapMs;
}

export function startEventLoopWatchdog(): { stop: () => void } {
  if (Bun.isStandaloneExecutable === true) {
    return { stop: () => undefined };
  }
  const worker = new Worker(new URL("./event-loop-watchdog-worker.ts", import.meta.url), { name: "devctl-watchdog" });
  const beat = (): void => {
    worker.postMessage({ type: "beat" });
  };
  beat();
  const timer = setWatchInterval(beat, WATCHDOG_TICK_MS);
  timer.unref();
  worker.addEventListener("error", (event) => {
    event.stopImmediatePropagation();
  });
  return {
    stop: () => {
      clearWatchInterval(timer);
      void worker.terminate();
    },
  };
}
