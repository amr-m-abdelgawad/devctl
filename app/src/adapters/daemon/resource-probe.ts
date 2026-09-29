let lagMs = 0;
let watchdog: "ok" | "degraded" | undefined;

export function noteEventLoopLag(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) {
    lagMs = ms;
  }
}

export function eventLoopLagMs(): number {
  return lagMs;
}

/** "degraded" while the watchdog worker is down and waiting to be respawned. */
export function noteWatchdog(state: "ok" | "degraded"): void {
  watchdog = state;
}

/** Undefined until a watchdog has started in this process. */
export function watchdogState(): "ok" | "degraded" | undefined {
  return watchdog;
}
