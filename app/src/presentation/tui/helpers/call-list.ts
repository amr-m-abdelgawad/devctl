export function pinnedCallIndex(calls: ReadonlyArray<{ readonly id: string }>, selectedId: string | undefined): number {
  if (!selectedId) {
    return 0;
  }
  return calls.findIndex((call) => call.id === selectedId);
}

// Scroll-into-view should key off the pinned id, not the row index. A newer
// hop prepends and shifts the index without the user moving; that must not
// yank the viewport back to the highlight. j/k changes the id and still
// brings the cursor on screen. Static lists omit the id and key off index.
export function selectionScrollKey(selectedIndex: number, selectedId?: string): string {
  return selectedId ? selectedId : String(selectedIndex);
}

export type CallListFreeze = {
  readonly frozenId: string | undefined;
  readonly headId: string | undefined;
};

// While the user is scrolled away from the top, keep the previous head at
// the top of the scrollbox so newer hops never insert above the viewport.
export function nextCallListFreeze(previousHead: string | undefined, ids: readonly string[], atTop: boolean): CallListFreeze {
  const headId = ids[0];
  if (!headId) {
    return { frozenId: undefined, headId: undefined };
  }
  if (atTop) {
    return { frozenId: undefined, headId };
  }
  const frozenId = previousHead && ids.includes(previousHead) ? previousHead : headId;
  return { frozenId, headId: frozenId };
}

export function frozenCallListStart(ids: readonly string[], frozenId: string | undefined, selectedIndex: number): number {
  if (!frozenId) {
    return 0;
  }
  const index = ids.indexOf(frozenId);
  const start = index < 0 ? 0 : index;
  if (selectedIndex >= 0 && selectedIndex < start) {
    return selectedIndex;
  }
  return start;
}

export function stepCallIndex(count: number, current: number, delta: number): number {
  if (count <= 0) {
    return 0;
  }
  const from = current < 0 ? 0 : current;
  return Math.max(0, Math.min(count - 1, from + delta));
}
