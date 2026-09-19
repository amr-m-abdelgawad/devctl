import type { RouteTimeoutConfig } from "../../domain/config/types.ts";
import { nextIdleFireMs, nextTotalFireMs, routeTimeouts } from "../../domain/proxy/timeout.ts";

export type TimeoutKind = "idle" | "total";

export type RouteTimeoutHandle = {
  touch: () => void;
  stop: () => void;
};

// Adapter-side timers. Domain helpers decide whether a deadline is active and
// when the next idle/total fire is due; this arms setTimeout and resets idle
// on each chunk via touch().
export function startRouteTimeout(
  timeout: RouteTimeoutConfig | undefined,
  onTimeout: (kind: TimeoutKind) => void,
  now: () => number = Date.now,
): RouteTimeoutHandle {
  const { idleMs, totalMs } = routeTimeouts(timeout);
  if (idleMs === undefined && totalMs === undefined) {
    return { touch() {}, stop() {} };
  }
  const startedAt = now();
  let lastActivityAt = startedAt;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clear = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (totalTimer !== undefined) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
  };

  const fire = (kind: TimeoutKind): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clear();
    onTimeout(kind);
  };

  const armIdle = (): void => {
    if (idleMs === undefined) {
      return;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    const delay = nextIdleFireMs(now(), lastActivityAt, idleMs);
    if (delay === undefined) {
      return;
    }
    idleTimer = setTimeout(() => fire("idle"), delay);
  };

  if (totalMs !== undefined) {
    const delay = nextTotalFireMs(now(), startedAt, totalMs);
    if (delay !== undefined) {
      totalTimer = setTimeout(() => fire("total"), delay);
    }
  }
  armIdle();

  return {
    touch() {
      if (stopped) {
        return;
      }
      lastActivityAt = now();
      armIdle();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

export function timeoutMessage(kind: TimeoutKind): string {
  return kind === "idle" ? "proxy idle timeout" : "proxy total timeout";
}
