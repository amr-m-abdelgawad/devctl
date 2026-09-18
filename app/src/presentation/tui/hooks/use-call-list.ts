import { type ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { frozenCallListStart, nextCallListFreeze, pinnedCallIndex, selectionScrollKey, stepCallIndex } from "../helpers/call-list.ts";

export function useCallListSelection<T extends { id: string }>(calls: readonly T[]) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const selectedIndex = pinnedCallIndex(calls, selectedId);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  useEffect(() => {
    const newest = calls[0];
    if (!newest) {
      return;
    }
    if (selectedId && calls.some((call) => call.id === selectedId)) {
      return;
    }
    setSelectedId(newest.id);
  }, [calls, selectedId]);

  const pick = useCallback((index: number) => {
    const call = callsRef.current[index];
    if (!call) {
      return;
    }
    setSelectedId(call.id);
  }, []);

  const move = useCallback((delta: number) => {
    pick(stepCallIndex(callsRef.current.length, selectedIndexRef.current, delta));
  }, [pick]);

  return { selectedId, selectedIndex, pick, move };
}

export function useCallListScroll<T extends { id: string }>(
  selected: number,
  idPrefix: string,
  calls: readonly T[],
  selectedId?: string,
) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const headIdRef = useRef<string | undefined>(undefined);
  const pin = selectionScrollKey(selected, selectedId);
  const prevPinRef = useRef(pin);

  // Snapshot: the box still has last commit's children, so scrollTop is the
  // user's position before this render prepends newer hops.
  const atTop = (scrollRef.current?.scrollTop ?? 0) <= 0;
  const ids = calls.map((call) => call.id);
  const freeze = nextCallListFreeze(headIdRef.current, ids, atTop);
  headIdRef.current = freeze.headId;
  const visibleStart = frozenCallListStart(ids, freeze.frozenId, selected);
  const visibleCalls = visibleStart > 0 ? calls.slice(visibleStart) : calls;

  useLayoutEffect(() => {
    if (prevPinRef.current === pin) {
      return;
    }
    prevPinRef.current = pin;
    const box = scrollRef.current;
    const index = selectedRef.current;
    if (!box || index < 0) {
      return;
    }
    const childId = selectedId ? `${idPrefix}-${selectedId}` : `${idPrefix}-${index}`;
    box.scrollChildIntoView(childId);
  }, [idPrefix, pin, selectedId]);

  return { scrollRef, visibleCalls, visibleStart };
}
