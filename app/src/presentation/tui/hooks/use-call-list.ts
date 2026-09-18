import { useCallback, useEffect, useRef, useState } from "react";
import { pinnedCallIndex, stepCallIndex } from "../helpers/call-list.ts";

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
