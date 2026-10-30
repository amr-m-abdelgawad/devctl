/** The timeline is emptied this often. */
export const TIMELINE_CLEAR_MS = 5_000;

export type Timeline = Pick<Performance, "clearMeasures" | "clearMarks">;

export type TimelineTimers = {
  readonly setInterval: (run: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
};

const realTimers: TimelineTimers = {
  setInterval: (run, ms) => {
    const handle = setInterval(run, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Keeps the process's performance timeline empty while the TUI runs, and
 * returns a stop function. React's development build adds a
 * `performance.measure()` entry for every component render it times, and
 * nothing removes them: the entries live in native memory the JS heap does
 * not count, and a TUI left open with services logging grew by gigabytes an
 * hour. devctl never reads the timeline. Every run uses React's production
 * build unless NODE_ENV says otherwise (shared/react-build.ts), and that
 * records none; this bounds a development run, which stays slow with many
 * logs held, and any library that marks or measures.
 */
export function keepPerformanceTimelineEmpty(timeline: Timeline = performance, timers: TimelineTimers = realTimers): () => void {
  const clear = (): void => {
    timeline.clearMeasures();
    timeline.clearMarks();
  };
  const handle = timers.setInterval(clear, TIMELINE_CLEAR_MS);
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    timers.clearInterval(handle);
    clear();
  };
}
