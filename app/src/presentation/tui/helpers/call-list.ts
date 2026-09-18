export function pinnedCallIndex(calls: ReadonlyArray<{ readonly id: string }>, selectedId: string | undefined): number {
  if (!selectedId) {
    return 0;
  }
  return calls.findIndex((call) => call.id === selectedId);
}

export function stepCallIndex(count: number, current: number, delta: number): number {
  if (count <= 0) {
    return 0;
  }
  const from = current < 0 ? 0 : current;
  return Math.max(0, Math.min(count - 1, from + delta));
}
