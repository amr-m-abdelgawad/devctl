import type { RouteTimeoutConfig } from "../config/types.ts";

// 0 / omitted / missing timeout block = unlimited (current proxy behavior).
export function timeoutMs(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

export function routeTimeouts(timeout: RouteTimeoutConfig | undefined): { idleMs?: number; totalMs?: number } {
  return {
    idleMs: timeoutMs(timeout?.idle_ms),
    totalMs: timeoutMs(timeout?.total_ms),
  };
}

export function deadlineExpired(now: number, startedAt: number, totalMs: number | undefined): boolean {
  const ms = timeoutMs(totalMs);
  return ms !== undefined && now - startedAt >= ms;
}

export function idleExpired(now: number, lastActivityAt: number, idleMs: number | undefined): boolean {
  const ms = timeoutMs(idleMs);
  return ms !== undefined && now - lastActivityAt >= ms;
}

// Milliseconds until the next idle fire, or undefined when idle is unlimited.
export function nextIdleFireMs(now: number, lastActivityAt: number, idleMs: number | undefined): number | undefined {
  const ms = timeoutMs(idleMs);
  if (ms === undefined) {
    return undefined;
  }
  return Math.max(0, lastActivityAt + ms - now);
}

export function nextTotalFireMs(now: number, startedAt: number, totalMs: number | undefined): number | undefined {
  const ms = timeoutMs(totalMs);
  if (ms === undefined) {
    return undefined;
  }
  return Math.max(0, startedAt + ms - now);
}
