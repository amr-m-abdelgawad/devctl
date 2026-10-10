/** Status is re-read this often with no event at all, so CPU and memory stay live. */
export const STATUS_PERIOD_MS = 2_000;
/** An event waits this long so a burst of them costs one refresh. */
export const STATUS_COALESCE_MS = 30;
/** Refreshes start at least this far apart: at most four a second in a flood. */
export const STATUS_MIN_GAP_MS = 250;

export type RefreshTimers = {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

const realTimers: RefreshTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Keeps the status snapshot fresh: shortly after each event and every two
 * seconds regardless, with one refresh in flight at a time and no more than
 * four starts a second however fast events arrive.
 */
export class StatusRefresher {
  private timer: unknown;
  private dueAt = Number.POSITIVE_INFINITY;
  private lastStart = Number.NEGATIVE_INFINITY;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly refresh: () => Promise<unknown>,
    private readonly timers: RefreshTimers = realTimers,
  ) {}

  start(): void {
    this.request(STATUS_PERIOD_MS);
  }

  /** Something the status shows may have changed. */
  poke(): void {
    this.request(STATUS_COALESCE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private request(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    const now = this.timers.now();
    const at = Math.max(now + delayMs, this.lastStart + STATUS_MIN_GAP_MS);
    if (this.timer !== undefined && this.dueAt <= at) {
      return;
    }
    this.cancel();
    this.dueAt = at;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.dueAt = Number.POSITIVE_INFINITY;
      this.fire();
    }, at - now);
  }

  private fire(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.lastStart = this.timers.now();
    void this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.request(0);
        }
        this.request(STATUS_PERIOD_MS);
      });
  }

  private cancel(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dueAt = Number.POSITIVE_INFINITY;
  }
}
