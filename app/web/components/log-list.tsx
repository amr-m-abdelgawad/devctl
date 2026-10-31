import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";
import { clockMs } from "../format.ts";
import { cn } from "../lib/utils.ts";
import {
  CLIP_ROW_HEIGHT,
  COMPACT_LOG_ROW_HEIGHT,
  estimateWrappedHeight,
  indexAtOffset,
  isErrorLog,
  isLogFollowBottom,
  logFollowMaxScroll,
  LOG_FOLLOW_SLACK_PX,
  LOG_OVERSCAN,
  clipLogMessage,
  logIdentity,
  logRowExpanded,
  logSearchFinder,
  type LogSearchSpan,
  nextLogFollowAction,
  nextLogSelectionIndex,
  rowOffsets,
  visibleIndexRange,
  type LogWrapMode,
} from "../logs.ts";
import { serviceColor } from "../palette.ts";
import type { LogRow } from "../types.ts";
import { Empty, TraceLink } from "./primitives.tsx";
import { StatusBadge } from "./status.tsx";
import { Button } from "./ui/button.tsx";
import { ArrowUpRightIcon } from "../icons.ts";

const TOP_LOAD_COOLDOWN_MS = 400;

export type LogListProps = {
  events: LogRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  onInspect: (id: string) => void;
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
  search?: string;
  regex?: boolean;
};

export function LogList(props: LogListProps) {
  const {
    events,
    selectedId,
    onSelect,
    onInspect,
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
    search = "",
    regex = false,
  } = props;
  const findSearch = useMemo(() => logSearchFinder(search, regex), [search, regex]);
  const serviceCh = useMemo(() => {
    let longest = 0;
    for (const event of events) {
      if (event.service.length > longest) {
        longest = event.service.length;
      }
    }
    return Math.max(longest, 1);
  }, [events]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const armedRef = useRef(false);
  const topLockRef = useRef(false);
  const firstIdRef = useRef("");
  const widthRef = useRef(0);
  const prevMetrics = useRef({ top: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(320);
  const [width, setWidth] = useState(0);
  const compact = width < 640;
  const baseHeight = compact ? COMPACT_LOG_ROW_HEIGHT : CLIP_ROW_HEIGHT;
  const listId = useId();
  const [measured, setMeasured] = useState<Record<string, number>>({});

  const heightAt = useCallback(
    (index: number): number => {
      const row = events[index];
      if (!row) {
        return baseHeight;
      }
      const id = logIdentity(row, index);
      if (!logRowExpanded(wrapMode, id === selectedId)) {
        return baseHeight;
      }
      return Math.max(baseHeight, measured[id] ?? estimateWrappedHeight(row.message) + (compact ? 28 : 0));
    },
    [events, measured, selectedId, wrapMode, baseHeight, compact],
  );

  const offsets = useMemo(() => rowOffsets(events.length, heightAt), [events.length, heightAt]);
  const totalHeight = offsets[events.length] ?? 0;
  const variable = compact || wrapMode !== "clip";
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
      if (widthRef.current !== el.clientWidth) {
        widthRef.current = el.clientWidth;
        setMeasured({});
        setWidth(el.clientWidth);
      }
    });
    frame.observe(el);
    setViewport(el.clientHeight);
    setWidth(el.clientWidth);
    return () => frame.disconnect();
  }, [events.length === 0]);

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

  const alignedSelection = useRef("");
  useLayoutEffect(() => {
    if (selectedId === "") {
      alignedSelection.current = "";
      return;
    }
    // Live updates rewrite the list. Only a new selection should move the
    // viewport; scrolling away from the current row must stay where the user left it.
    if (follow || alignedSelection.current === selectedId) {
      return;
    }
    const index = events.findIndex((row, rowIndex) => logIdentity(row, rowIndex) === selectedId);
    const el = scrollerRef.current;
    if (index < 0 || !el) {
      return;
    }
    alignedSelection.current = selectedId;
    const top = offsets[index] ?? 0;
    const bottom = offsets[index + 1] ?? top + baseHeight;
    if (top < el.scrollTop || bottom - top >= el.clientHeight) {
      el.scrollTop = top;
    } else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight;
    }
    setScrollTop(el.scrollTop);
  }, [events, follow, offsets, selectedId, baseHeight]);

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
        aria-activedescendant={
          slice.some((row, offset) => logIdentity(row, range.start + offset) === selectedId) ? `${listId}-${selectedId}` : undefined
        }
        aria-keyshortcuts="ArrowUp ArrowDown Home End Enter"
        tabIndex={0}
        className="log-scroller absolute inset-0 overflow-auto font-mono text-[13px]"
        style={{ "--log-service-ch": serviceCh } as CSSProperties}
        onScroll={onScroll}
        onMouseDown={onActivate}
        onFocus={onActivate}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
          const current = events.findIndex((row, index) => logIdentity(row, index) === selectedId);
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            const index = current < 0 ? range.start : current;
            const row = events[index];
            if (row) {
              const id = logIdentity(row, index);
              onSelect(id);
              onInspect(id);
            }
            return;
          }
          const delta = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? events.length - 1
                : delta
                  ? nextLogSelectionIndex(events.length, current, delta)
                  : -1;
          if (index < 0) return;
          event.preventDefault();
          event.stopPropagation();
          const row = events[index];
          if (row) onSelect(logIdentity(row, index));
        }}
      >
        {loadingOlder ? <p className="px-2 py-1 text-[12px] text-muted-foreground">Loading older events…</p> : null}
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
                domId={`${listId}-${id}`}
                top={top}
                expanded={expanded}
                compact={compact}
                selected={id === selectedId}
                showTimestamps={showTimestamps}
                showMeta={showMeta}
                findSearch={findSearch}
                onSelect={(id) => {
                  scrollerRef.current?.focus({ preventScroll: true });
                  onSelect(id);
                }}
                onInspect={onInspect}
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
  domId: string;
  top: number;
  expanded: boolean;
  compact: boolean;
  selected: boolean;
  showTimestamps: boolean;
  showMeta: boolean;
  findSearch: (text: string) => LogSearchSpan[];
  onSelect: (id: string) => void;
  onInspect: (id: string) => void;
  onMeasure: (id: string, height: number) => void;
}) {
  const { row, id, domId, top, expanded, compact, selected, showTimestamps, showMeta, findSearch, onSelect, onInspect, onMeasure } = props;
  const level = row.level || row.severityText || "info";
  const error = isErrorLog(row);
  const shown = expanded ? row.message : clipLogMessage(row.message);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (expanded && ref.current) {
      onMeasure(id, ref.current.offsetHeight);
      const observer = new ResizeObserver(() => {
        if (ref.current) onMeasure(id, ref.current.offsetHeight);
      });
      observer.observe(ref.current);
      return () => observer.disconnect();
    }
  }, [expanded, id, onMeasure, row.message, compact]);
  return (
    <div
      ref={ref}
      id={domId}
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(id)}
      onDoubleClick={() => onInspect(id)}
      className={cn(
        "log-event absolute inset-x-0 w-full cursor-pointer text-left",
        compact && "log-event-compact",
        expanded && "log-event-expanded",
        error && "log-event-error",
        selected && "log-event-selected",
      )}
      style={{ top, minHeight: compact ? COMPACT_LOG_ROW_HEIGHT : CLIP_ROW_HEIGHT }}
    >
      <div className="log-event-meta">
        {showTimestamps ? (
          <time className="log-event-time" dateTime={row.timestamp}>
            {clockMs(row.timestamp)}
          </time>
        ) : null}
        <span className="log-event-service" title={row.service}>
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: serviceColor(row.service) }} />
          <LogSearchText text={row.service} find={findSearch} />
        </span>
        <StatusBadge value={level} className="shrink-0" />
        {showMeta ? (
          <span className="log-event-source" title={row.source}>
            <LogSearchText text={row.source} find={findSearch} />
          </span>
        ) : null}
        {row.traceId ? (
          <span className="log-event-trace" onClick={(event) => event.stopPropagation()}>
            <TraceLink id={row.traceId} />
          </span>
        ) : null}
      </div>
      <span className="log-event-message" title={row.message}>
        <LogSearchText text={shown} find={findSearch} />
      </span>
      <button
        type="button"
        className="log-event-inspect"
        tabIndex={-1}
        aria-label={`Inspect log from ${row.service} at ${clockMs(row.timestamp)}`}
        title="Inspect record · Enter"
        onClick={(event) => {
          event.stopPropagation();
          onInspect(id);
        }}
      >
        <ArrowUpRightIcon aria-hidden="true" />
      </button>
    </div>
  );
}

export function LogSearchText(props: { text: string; find: (text: string) => LogSearchSpan[] }): ReactNode {
  const spans = props.find(props.text);
  if (spans.length === 0) {
    return props.text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    if (span.start > cursor) {
      parts.push(props.text.slice(cursor, span.start));
    }
    parts.push(
      <mark key={index} className="log-search-hit">
        {props.text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  }
  if (cursor < props.text.length) {
    parts.push(props.text.slice(cursor));
  }
  return parts;
}
