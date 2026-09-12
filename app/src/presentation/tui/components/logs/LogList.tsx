import { type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { formatBodySummary, type LogRecord } from "../../../../domain/logs/logs.ts";
import { padClip } from "../../helpers/format.ts";
import {
  displayLogLevel,
  LOG_COL_GAP,
  LOG_LEVEL_COL,
  LOG_META_COL,
  LOG_TIME_COL,
  logMessageSpans,
  logRowExpanded,
  logServiceColumnWidth,
  type LogWrapMode,
} from "../../helpers/logs.ts";
import { logSpanColor, serviceColor, stateColor, type Palette } from "../../themes.ts";

const FOLLOW_POLL_MS = 200;
const FOLLOW_SLACK = 2;
const TRACE_MARK = "◎";

export function LogList(props: {
  palette: Palette;
  logs: LogRecord[];
  limit?: number;
  width?: number;
  followTick?: number;
  focused?: boolean;
  wrapMode?: LogWrapMode;
  selected?: number;
  follow?: boolean;
  showTimestamps?: boolean;
  showMeta?: boolean;
  onPick?: (index: number) => void;
  onLeaveLatest?: () => void;
  viewStart?: number;
  search?: string;
  regex?: boolean;
}) {
  const {
    palette,
    logs,
    limit,
    width = 80,
    followTick = 0,
    focused = false,
    wrapMode = "all",
    selected = -1,
    follow = true,
    showTimestamps = true,
    showMeta = true,
    onPick,
    onLeaveLatest,
    viewStart = 0,
    search = "",
    regex = false,
  } = props;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const alignedSelection = useRef("");
  const onLeaveLatestRef = useRef(onLeaveLatest);
  useEffect(() => {
    onLeaveLatestRef.current = onLeaveLatest;
  }, [onLeaveLatest]);
  const slice = limit === undefined ? logs : logs.slice(-limit);
  const serviceNames = [...new Set(logs.map((ev) => ev.service))];
  const serviceWidth = logServiceColumnWidth(width, serviceNames);
  const tail = slice[slice.length - 1];
  const tailKey = tail === undefined ? "empty" : String(tail.seq);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) {
      return;
    }
    box.stickyScroll = follow;
    if (follow) {
      box.stickyStart = "bottom";
      box.scrollTo({ x: box.scrollLeft, y: Math.max(0, box.scrollHeight) });
    }
  }, [follow, followTick, tailKey]);

  useEffect(() => {
    const alignment = `${viewStart}:${selected}:${wrapMode}`;
    if (alignedSelection.current === alignment) {
      return;
    }
    alignedSelection.current = alignment;
    if (follow && (selected < 0 || selected >= slice.length - 1)) {
      return;
    }
    const box = scrollRef.current;
    if (!box || selected < 0) {
      return;
    }
    const id = `log-row-${selected}`;
    const frame = requestAnimationFrame(() => {
      box.stickyScroll = false;
      box.scrollChildIntoView(id);
    });
    return () => cancelAnimationFrame(frame);
  }, [follow, selected, slice.length, viewStart, wrapMode]);

  useEffect(() => {
    if (!follow || !onLeaveLatest) {
      return;
    }
    let armed = false;
    let lastHeight = 0;
    let lastScrollTop = 0;
    const id = setInterval(() => {
      const box = scrollRef.current;
      if (!box) {
        return;
      }
      const viewH = box.viewport.height;
      if (viewH <= 0) {
        return;
      }
      const height = box.scrollHeight;
      const scrollTop = box.scrollTop;
      if (scrollTop < lastScrollTop) {
        box.stickyScroll = false;
        lastScrollTop = scrollTop;
        lastHeight = height;
        onLeaveLatestRef.current?.();
        return;
      }
      lastScrollTop = scrollTop;
      const atBottom = scrollTop + viewH >= height - FOLLOW_SLACK;
      if (atBottom) {
        armed = true;
        lastHeight = height;
        return;
      }
      if (height > lastHeight) {
        box.stickyScroll = true;
        box.stickyStart = "bottom";
        box.scrollTo({ x: box.scrollLeft, y: Math.max(0, height) });
        lastHeight = height;
        return;
      }
      if (armed) {
        onLeaveLatestRef.current?.();
      }
    }, FOLLOW_POLL_MS);
    return () => {
      clearInterval(id);
    };
  }, [follow, followTick, onLeaveLatest]);

  return (
    <box flexGrow={1} height="100%" flexDirection="column" overflow="hidden">
      <LogHeader palette={palette} serviceWidth={serviceWidth} showTimestamps={showTimestamps} showMeta={showMeta} />
      <scrollbox
        ref={scrollRef}
        focused={focused}
        stickyScroll={follow}
        stickyStart="bottom"
        scrollX={false}
        style={{
          rootOptions: { flexGrow: 1, height: "100%", overflow: "hidden", backgroundColor: palette.panel },
          viewportOptions: { backgroundColor: palette.panel },
          contentOptions: { backgroundColor: palette.panel },
          scrollbarOptions: {
            trackOptions: {
              foregroundColor: palette.primary,
              backgroundColor: palette.element,
            },
          },
        }}
      >
        <box flexDirection="column" overflow="hidden">
          {slice.map((ev, i) => (
            <LogRow
              id={`log-row-${i}`}
              key={`${ev.timestamp}-${ev.service}-${i}`}
              palette={palette}
              event={ev}
              serviceWidth={serviceWidth}
              expanded={logRowExpanded(wrapMode, i === selected)}
              active={i === selected}
              showTimestamps={showTimestamps}
              showMeta={showMeta}
              onPick={onPick ? () => onPick(i) : undefined}
              search={search}
              regex={regex}
            />
          ))}
        </box>
      </scrollbox>
    </box>
  );
}

function LogHeader(props: {
  palette: Palette;
  serviceWidth: number;
  showTimestamps: boolean;
  showMeta: boolean;
}) {
  const { palette, serviceWidth, showTimestamps, showMeta } = props;
  return (
    <box height={1} flexShrink={0} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      <LogChrome
        palette={palette}
        serviceWidth={serviceWidth}
        showTimestamps={showTimestamps}
        showMeta={showMeta}
        time="TIME"
        service="SERVICE"
        level="LEVEL"
        meta="SRC"
        header
      />
      <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <text fg={palette.muted} wrapMode="none">
          MESSAGE
        </text>
      </box>
    </box>
  );
}

function LogRow(props: {
  id: string;
  palette: Palette;
  event: LogRecord;
  serviceWidth: number;
  expanded: boolean;
  active: boolean;
  showTimestamps?: boolean;
  showMeta?: boolean;
  onPick?: () => void;
  search?: string;
  regex?: boolean;
}) {
  const { id, palette, event, serviceWidth, expanded, active, showTimestamps = true, showMeta = true, onPick, search = "", regex = false } = props;
  const summary = formatBodySummary(event);
  const level = event.severityText;
  const meta = event.source ? (event.traceId ? `${TRACE_MARK}${event.source}` : event.source) : "";
  return (
    <box
      id={id}
      flexShrink={0}
      flexDirection="row"
      alignItems="flex-start"
      overflow="hidden"
      height={expanded ? "auto" : 1}
      backgroundColor={active ? palette.highlight : undefined}
      onMouseDown={onPick}
    >
      <LogChrome
        palette={palette}
        serviceWidth={serviceWidth}
        showTimestamps={showTimestamps}
        showMeta={showMeta}
        time={event.timestamp.slice(11, 19)}
        service={event.service}
        level={level}
        meta={meta}
      />
      <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <LogMessage palette={palette} level={level} text={summary} wrap={expanded} search={search} regex={regex} />
      </box>
    </box>
  );
}

function LogChrome(props: {
  palette: Palette;
  serviceWidth: number;
  showTimestamps: boolean;
  showMeta: boolean;
  time: string;
  service: string;
  level: string;
  meta: string;
  header?: boolean;
}) {
  const { palette, serviceWidth, showTimestamps, showMeta, time, service, level, meta, header = false } = props;
  const fg = header ? palette.muted : undefined;
  return (
    <box flexShrink={0} flexDirection="row" overflow="hidden">
      {showTimestamps ? (
        <LogField width={LOG_TIME_COL} fg={fg ?? palette.muted} text={time} />
      ) : null}
      <LogField width={serviceWidth} fg={fg ?? serviceColor(service, palette)} text={service} />
      <box width={LOG_COL_GAP} flexShrink={0} overflow="hidden">
        <text> </text>
      </box>
      <LogField width={LOG_LEVEL_COL} fg={fg ?? stateColor(palette, level)} text={header ? level : displayLogLevel(level)} />
      {showMeta ? <LogField width={LOG_META_COL} fg={fg ?? palette.muted} text={meta} /> : null}
      <box width={LOG_COL_GAP} flexShrink={0} overflow="hidden">
        <text> </text>
      </box>
    </box>
  );
}

function LogField(props: { width: number; fg: string; text: string }) {
  const { width, fg, text } = props;
  return (
    <box width={width} flexShrink={0} overflow="hidden">
      <text fg={fg} wrapMode="none">
        {padClip(text, width)}
      </text>
    </box>
  );
}

function LogMessage(props: {
  palette: Palette;
  level: string;
  text: string;
  wrap: boolean;
  search?: string;
  regex?: boolean;
}) {
  const { palette, level, text, wrap, search = "", regex = false } = props;
  return (
    <text wrapMode={wrap ? "word" : "none"} truncate={!wrap} flexShrink={0} width="100%">
      {logMessageSpans(text, search, regex).map((span, spanIndex) => (
        <span key={`${span.kind}-${spanIndex}`} fg={logSpanColor(palette, level, span.kind)}>
          {span.text}
        </span>
      ))}
    </text>
  );
}
