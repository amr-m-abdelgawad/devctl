import { type ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { callDetailStale, frozenCallListStart, nextCallListFreeze, pinnedCallIndex, selectionScrollKey, stepCallIndex, withCallDetail } from "../helpers/call-list.ts";

/** Runs `refresh` now and then every `intervalMs` while `active`. */
export function useCallListPolling(active: boolean, refresh: () => Promise<void>, intervalMs: number): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, refresh, intervalMs]);
}

/**
 * Selection and detail over a list polled without bodies. Only the selected
 * row's full record is fetched, when the selection or that row's seq changes,
 * and it replaces the row so the inspector and the detail overlay show its
 * payloads. A late answer for an earlier selection is ignored.
 */
export function useCallDetails<T extends { id: string; seq: number }, P extends { calls: T[] }>(page: P, fetchCall: ((id: string) => Promise<T | undefined>) | undefined) {
  const rows = page.calls;
  const selection = useCallListSelection(rows);
  const [full, setFull] = useState<T | undefined>(undefined);
  const [detail, setDetail] = useState<T | undefined>(undefined);
  const fullRef = useRef(full);
  fullRef.current = full;
  const fetchRef = useRef(fetchCall);
  fetchRef.current = fetchCall;
  const row = selection.selectedId === undefined ? undefined : rows.find((call) => call.id === selection.selectedId);
  const rowId = row?.id;
  const rowSeq = row?.seq;
  const canFetch = fetchCall !== undefined;

  useEffect(() => {
    const fetch = fetchRef.current;
    if (!fetch || rowId === undefined || rowSeq === undefined || !callDetailStale({ id: rowId, seq: rowSeq }, fullRef.current)) {
      return;
    }
    let current = true;
    fetch(rowId).then((call) => {
      if (current && call) {
        setFull(call);
      }
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [canFetch, rowId, rowSeq]);

  // An overlay opened on the summary row picks up the full record once it lands.
  useEffect(() => {
    if (full !== undefined) {
      setDetail((open) => (open?.id === full.id ? full : open));
    }
  }, [full]);

  const shown = useMemo(() => ({ ...page, calls: [...withCallDetail(rows, full)] }), [page, rows, full]);
  return { page: shown, detail, setDetail, selectedIndex: selection.selectedIndex, pick: selection.pick, move: selection.move };
}

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
