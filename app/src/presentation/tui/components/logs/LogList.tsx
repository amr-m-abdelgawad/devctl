import { type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { type LogEvent } from "../../../../domain/logs/logs.ts";
import { padClip } from "../../helpers/format.ts";
import {
  displayLogLevel,
  foldLogLines,
  LOG_COL_GAP,
  LOG_LEVEL_COL,
  LOG_META_COL,
  LOG_TIME_COL,
  logMessageSpans,
  logMessageWidth,
  logRowExpanded,
  logServiceColumnWidth,
  wrapLogMessage,
  type LogWrapMode,
} from "../../helpers/logs.ts";
import { logSpanColor, serviceColor, stateColor, type Palette } from "../../themes.ts";

const FOLLOW_POLL_MS = 200;
const FOLLOW_SLACK = 2;

export function LogList(props: {
  palette: Palette;
  logs: LogEvent[];
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
    wrapMode = "clip",
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
  const slice = limit === undefined ? logs : logs.slice(-limit);
  const serviceNames = [...new Set(logs.map((ev) => ev.service))];
  const serviceWidth = logServiceColumnWidth(width, serviceNames);
  const msgWidth = logMessageWidth({ width, serviceWidth, showTimestamps, showMeta });
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
      const atBottom = box.scrollTop + viewH >= height - FOLLOW_SLACK;
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
        onLeaveLatest();
      }
    }, FOLLOW_POLL_MS);
    return () => {
      clearInterval(id);
    };
  }, [follow, followTick, onLeaveLatest]);

  return (
    <box flexGrow={1} height="100%" overflow="hidden">
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
              msgWidth={msgWidth}
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

function LogRow(props: {
  id: string;
  palette: Palette;
  event: LogEvent;
  serviceWidth: number;
  msgWidth: number;
  expanded: boolean;
  active: boolean;
  showTimestamps?: boolean;
  showMeta?: boolean;
  onPick?: () => void;
  search?: string;
  regex?: boolean;
}) {
  const { id, palette, event, serviceWidth, msgWidth, expanded, active, showTimestamps = true, showMeta = true, onPick, search = "", regex = false } = props;
  const fold = foldLogLines(wrapLogMessage(event.message, msgWidth), msgWidth, expanded);
  return (
    <box
      id={id}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={active ? palette.highlight : undefined}
      onMouseDown={onPick}
    >
      {fold.visible.map((line, lineIndex) => (
        <box key={`${event.timestamp}-${lineIndex}`} height={1} flexDirection="row" overflow="hidden">
          {showTimestamps ? (
            <box width={LOG_TIME_COL} flexShrink={0} overflow="hidden">
              <text fg={palette.muted}>{lineIndex === 0 ? event.timestamp.slice(11, 19) : ""}</text>
            </box>
          ) : null}
          <box width={serviceWidth} flexShrink={0} overflow="hidden">
            <text fg={lineIndex === 0 ? serviceColor(event.service, palette) : palette.muted} wrapMode="none">
              {lineIndex === 0 ? padClip(event.service, serviceWidth) : ""}
            </text>
          </box>
          <box width={LOG_COL_GAP} flexShrink={0} overflow="hidden">
            <text> </text>
          </box>
          <box width={LOG_LEVEL_COL} flexShrink={0} overflow="hidden">
            <text fg={lineIndex === 0 ? stateColor(palette, event.level) : palette.muted}>
              {lineIndex === 0 ? displayLogLevel(String(event.level)) : ""}
            </text>
          </box>
          {showMeta ? (
            <box width={LOG_META_COL} flexShrink={0} overflow="hidden">
              <text fg={palette.muted}>{lineIndex === 0 && event.source ? padClip(event.source, LOG_META_COL) : ""}</text>
            </box>
          ) : null}
          <box width={LOG_COL_GAP} flexShrink={0} overflow="hidden">
            <text fg={palette.muted}>{lineIndex === 0 ? " " : "│"}</text>
          </box>
          <box flexGrow={1} overflow="hidden">
            <LogMessage palette={palette} level={event.level} text={line} mark={lineIndex === 0 ? fold.mark : ""} search={search} regex={regex} />
          </box>
        </box>
      ))}
    </box>
  );
}

function LogMessage(props: { palette: Palette; level: string; text: string; mark: string; search?: string; regex?: boolean }) {
  const { palette, level, text, mark, search = "", regex = false } = props;
  return (
    <text wrapMode="none">
      {logMessageSpans(text, search, regex).map((span, spanIndex) => (
        <span key={`${span.kind}-${spanIndex}`} fg={logSpanColor(palette, level, span.kind)}>
          {span.text}
        </span>
      ))}
      {mark === "" ? null : <span fg={palette.muted}>{mark}</span>}
    </text>
  );
}
