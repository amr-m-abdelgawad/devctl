import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { clockMs } from "../format.ts";
import { cn } from "../lib/utils.ts";
import {
  CLIP_ROW_HEIGHT,
  estimateWrappedHeight,
  indexAtOffset,
  isErrorLog,
  isLogFollowBottom,
  logFollowMaxScroll,
  LOG_FOLLOW_SLACK_PX,
  LOG_OVERSCAN,
  logIdentity,
  logRowExpanded,
  nextLogFollowAction,
  rowOffsets,
  visibleIndexRange,
  type LogWrapMode,
} from "../logs.ts";
import { serviceColor } from "../palette.ts";
import type { LogRow } from "../types.ts";
import { Empty, TraceLink } from "./primitives.tsx";
import { StatusBadge } from "./status.tsx";
import { Button } from "./ui/button.tsx";

const TOP_LOAD_COOLDOWN_MS = 400;

export type LogListProps = {
  events: LogRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  wrapMode: LogWrapMode;
  showTimestamps: boolean;
  showMeta: boolean;
  follow: boolean;
  followTick?: number;
  onPin: () => void;
  onJumpLatest: () => void;
  newer: number;
  onReachTop: () => void;
  loadingOlder?: boolean;
  empty?: string;
  onActivate?: () => void;
};

export function LogList(props: LogListProps) {
  const {
    events,
    selectedId,
    onSelect,
    wrapMode,
    showTimestamps,
    showMeta,
    follow,
    followTick = 0,
    onPin,
    onJumpLatest,
    newer,
    onReachTop,
    loadingOlder = false,
    empty = "No log records.",
    onActivate,
  } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const armedRef = useRef(false);
  const topLockRef = useRef(false);
  const firstIdRef = useRef("");
  const prevMetrics = useRef({ top: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(320);
  const [measured, setMeasured] = useState<Record<string, number>>({});

  const heightAt = useCallback((index: number): number => {
    const row = events[index];
    if (!row) {
      return CLIP_ROW_HEIGHT;
    }
    const id = logIdentity(row, index);
    if (!logRowExpanded(wrapMode, id === selectedId)) {
      return CLIP_ROW_HEIGHT;
    }
    return measured[id] ?? estimateWrappedHeight(row.message);
  }, [events, measured, selectedId, wrapMode]);

  const offsets = useMemo(() => rowOffsets(events.length, heightAt), [events.length, heightAt]);
  const totalHeight = offsets[events.length] ?? 0;
  const variable = wrapMode !== "clip";
  const range = useMemo(() => {
    if (variable) {
      const start = indexAtOffset(offsets, Math.max(0, scrollTop));
      const endIndex = indexAtOffset(offsets, scrollTop + viewport);
      return {
        start: Math.max(0, start - LOG_OVERSCAN),
        end: Math.min(events.length, endIndex + 1 + LOG_OVERSCAN),
      };
    }
    return visibleIndexRange(events.length, scrollTop, viewport, CLIP_ROW_HEIGHT, LOG_OVERSCAN);
  }, [events.length, offsets, scrollTop, variable, viewport]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) {
      return;
    }
    const frame = new ResizeObserver(() => {
      setViewport(el.clientHeight);
    });
    frame.observe(el);
    setViewport(el.clientHeight);
    return () => frame.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !follow) {
      return;
    }
    el.scrollTop = logFollowMaxScroll(el.scrollHeight, el.clientHeight);
    setScrollTop(el.scrollTop);
  }, [events.length, follow, followTick, totalHeight]);

  useLayoutEffect(() => {
    const first = events[0];
    const id = first ? logIdentity(first, 0) : "";
    const prev = firstIdRef.current;
    firstIdRef.current = id;
    const el = scrollerRef.current;
    if (prev === "" || id === prev || !el) {
      return;
    }
    const prevIndex = events.findIndex((row, index) => logIdentity(row, index) === prev);
    if (prevIndex <= 0) {
      return;
    }
    el.scrollTop += offsets[prevIndex] ?? 0;
    setScrollTop(el.scrollTop);
  }, [events, offsets]);

  useLayoutEffect(() => {
    if (follow || selectedId === "") {
      return;
    }
    const index = events.findIndex((row, rowIndex) => logIdentity(row, rowIndex) === selectedId);
    const el = scrollerRef.current;
    if (index < 0 || !el) {
      return;
    }
    const top = offsets[index] ?? 0;
    const bottom = offsets[index + 1] ?? top + CLIP_ROW_HEIGHT;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight;
    }
    setScrollTop(el.scrollTop);
  }, [events, follow, offsets, selectedId]);

  const onMeasure = useCallback((id: string, height: number): void => {
    setMeasured((current) => (current[id] === height ? current : { ...current, [id]: height }));
  }, []);

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    const atBottom = isLogFollowBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    const scrolledUp = el.scrollTop < prevMetrics.current.top - 1;
    const contentGrew = el.scrollHeight > prevMetrics.current.height + 1;
    const contentShrunk = el.scrollHeight < prevMetrics.current.height - 1;
    const next = nextLogFollowAction({
      follow,
      armed: armedRef.current,
      atBottom,
      scrolledUp,
      contentGrew,
      contentShrunk,
    });
    armedRef.current = next.armed;
    if (next.action === "pin") {
      onPin();
    } else if (next.action === "snap") {
      el.scrollTop = logFollowMaxScroll(el.scrollHeight, el.clientHeight);
    }
    prevMetrics.current = { top: el.scrollTop, height: el.scrollHeight };
    setScrollTop(el.scrollTop);
    if (el.scrollTop <= LOG_FOLLOW_SLACK_PX && !topLockRef.current) {
      topLockRef.current = true;
      onReachTop();
      window.setTimeout(() => {
        topLockRef.current = false;
      }, TOP_LOAD_COOLDOWN_MS);
    }
  };

  if (events.length === 0) {
    return <Empty>{empty}</Empty>;
  }

  const slice = events.slice(range.start, range.end);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        role="listbox"
        aria-label="Log events"
        tabIndex={0}
        className="absolute inset-0 overflow-auto font-mono text-[12px]"
        onScroll={onScroll}
        onMouseDown={onActivate}
        onFocus={onActivate}
      >
        {loadingOlder ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">Loading older events…</p>
        ) : null}
        <div className="relative w-full" style={{ height: totalHeight }}>
          {slice.map((row, offset) => {
            const index = range.start + offset;
            const id = logIdentity(row, index);
            const top = offsets[index] ?? index * CLIP_ROW_HEIGHT;
            const expanded = logRowExpanded(wrapMode, id === selectedId);
            return (
              <LogEventRow
                key={id}
                row={row}
                id={id}
                top={top}
                expanded={expanded}
                selected={id === selectedId}
                showTimestamps={showTimestamps}
                showMeta={showMeta}
                onSelect={onSelect}
                onMeasure={onMeasure}
              />
            );
          })}
        </div>
      </div>
      {follow ? null : (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button type="button" size="xs" className="pointer-events-auto shadow-md" onClick={onJumpLatest}>
            {newer > 0 ? `pinned · +${newer} new` : "jump to latest"}
          </Button>
        </div>
      )}
    </div>
  );
}

function LogEventRow(props: {
  row: LogRow;
  id: string;
  top: number;
  expanded: boolean;
  selected: boolean;
  showTimestamps: boolean;
  showMeta: boolean;
  onSelect: (id: string) => void;
  onMeasure: (id: string, height: number) => void;
}) {
  const { row, id, top, expanded, selected, showTimestamps, showMeta, onSelect, onMeasure } = props;
  const level = row.level || row.severityText || "info";
  const error = isErrorLog(row);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (expanded && ref.current) {
      onMeasure(id, ref.current.offsetHeight);
    }
  }, [expanded, id, onMeasure, row.message]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(id)}
      className={cn(
        "absolute inset-x-0 flex w-full cursor-pointer items-start gap-2 px-2 text-left outline-none hover:bg-accent/40",
        expanded ? "whitespace-pre-wrap break-all py-1" : "h-7 items-center overflow-hidden",
        error ? "bg-destructive/[0.06]" : undefined,
        selected ? "bg-primary/10" : undefined,
      )}
      style={{ top, minHeight: CLIP_ROW_HEIGHT }}
    >
      {showTimestamps ? (
        <span className="w-[5.6rem] shrink-0 text-[11px] text-muted-foreground">{clockMs(row.timestamp)}</span>
      ) : null}
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: serviceColor(row.service) }} />
      <span className="w-24 shrink-0 truncate text-[11px]" title={row.service}>{row.service}</span>
      <StatusBadge value={level} className="shrink-0" />
      {showMeta ? (
        <span className="w-14 shrink-0 truncate text-[10px] uppercase tracking-wide text-muted-foreground" title={row.source}>
          {row.source}
        </span>
      ) : null}
      <span className={cn("min-w-0 flex-1 text-[12px] text-foreground/90", expanded ? "" : "truncate")} title={row.message}>
        {row.message}
      </span>
      {row.traceId ? (
        <span onClick={(event) => event.stopPropagation()}>
          <TraceLink id={row.traceId} />
        </span>
      ) : null}
    </div>
  );
}
