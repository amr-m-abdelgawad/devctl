let lagMs = 0;

export function noteEventLoopLag(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) {
    lagMs = ms;
  }
}

export function eventLoopLagMs(): number {
  return lagMs;
}
