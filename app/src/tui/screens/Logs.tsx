import { useEffect, useRef } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import {
  filterLogs,
  foldLogLines,
  isSystemLogSource,
  LOG_COL_GAP,
  LOG_LEVEL_COL,
  LOG_META_COL,
  LOG_TIME_COL,
  logFilterCatalog,
  logMessageSpans,
  logMessageWidth,
  logPaneInnerWidth,
  logRowExpanded,
  logServiceColumnWidth,
  logWrapLabel,
  padClip,
  tabChipWidth,
  visibleHints,
  wrapLogMessage,
  type LogWrapMode,
} from "../helpers.ts";
import { Chip, KeyHints, MetaBar, TabStrip, Toolbar } from "../layout.tsx";
import { logSpanColor, serviceColor, stateColor, type Palette } from "../themes.ts";
import { type LogEvent } from "../../logs.ts";

const FOLLOW_ARM_MS = 400;
const FOLLOW_POLL_MS = 200;
const FOLLOW_SLACK = 2;

export function LogsScreen(props: {
  palette: Palette;
  logs: LogEvent[];
  names: string[];
  logSources?: string[];
  service: string;
  paused: boolean;
  errorOnly: boolean;
  showSystemLogs: boolean;
  search: string;
  searchFocused: boolean;
  followTick: number;
  width: number;
  source?: string;
  regex?: boolean;
  services?: string[];
  showTimestamps?: boolean;
  showMeta?: boolean;
  view?: LogEvent[];
  wrapMode?: LogWrapMode;
  selected?: number;
  follow?: boolean;
  newer?: number;
  viewStart?: number;
  viewTotal?: number;
  onSearch: (value: string) => void;
  onService: (service: string) => void;
  onToggleErrors: () => void;
  onToggleSystemLogs: () => void;
  onClearLogs: () => void;
  onSelect?: (index: number) => void;
  onLeaveLatest?: () => void;
  onOpenExports?: () => void;
  onJumpLatest?: () => void;
  fullscreen?: boolean;
}) {
  const {
    palette,
    logs,
    names,
    logSources,
    service,
    paused,
    errorOnly,
    showSystemLogs,
    search,
    searchFocused,
    followTick,
    width,
    onSearch,
    onService,
    onToggleErrors,
    onToggleSystemLogs,
    onClearLogs,
    onSelect,
    wrapMode = "focus",
    selected = -1,
    follow = true,
    newer = 0,
    viewStart = 0,
    viewTotal,
    onLeaveLatest,
    onOpenExports,
    onJumpLatest,
    view,
    fullscreen = false,
  } = props;
  const scale = useDensity();
  const innerWidth = logPaneInnerWidth(width, scale.pad, fullscreen);
  const filterBarLogs = showSystemLogs ? logs : logs.filter((ev) => !isSystemLogSource(ev.source));
  const filtered = filterLogs(logs, {
    service,
    services: props.services,
    errorOnly,
    search,
    regex: props.regex,
    source: props.source,
    systemLogs: showSystemLogs,
  });
  const shown = view ?? filtered;
  const shownTotal = viewTotal ?? filtered.length;
  const viewEnd = Math.min(shownTotal, viewStart + shown.length);
  const rangeLabel = shownTotal === 0 ? "empty" : `${viewStart + 1}–${viewEnd} of ${shownTotal}`;
  const selectedServices = props.services ?? [];
  const scope = selectedServices.length > 0 ? selectedServices.join(",") : service === "" ? "all services" : service;
  return (
    <box flexGrow={1} flexDirection="column" overflow="hidden">
      {fullscreen ? null : (
        <>
          <MetaBar
            palette={palette}
            items={[
              { text: paused ? "PAUSED" : "LIVE", tone: paused ? "warning" : "success" },
              { text: `shown ${shownTotal}`, tone: "info" },
              { text: `total ${logs.length}` },
              ...(view && shownTotal > view.length
                ? [{ text: `${viewStart + 1}–${viewStart + view.length} / ${shownTotal}`, tone: "info" as const }]
                : []),
              { text: scope, tone: service === "" ? "idle" : "primary" },
              { text: logWrapLabel(wrapMode), tone: wrapMode === "clip" ? "idle" : "accent" },
              ...(follow ? [] : [{ text: newer > 0 ? `pinned · +${newer} new` : "pinned", tone: "warning" as const }]),
              { text: errorOnly ? "ERROR+" : "all levels", tone: errorOnly ? "error" : "idle", onMouseDown: onToggleErrors },
              { text: showSystemLogs ? "system: on" : "system: off", tone: showSystemLogs ? "accent" : "idle", onMouseDown: onToggleSystemLogs },
              ...(props.source ? [{ text: `src ${props.source}`, tone: "info" as const }] : []),
              ...(props.regex ? [{ text: "regex", tone: "accent" as const }] : []),
              ...(search === "" ? [] : [{ text: `search ${search}`, tone: "accent" as const }]),
              { text: "clear", tone: "muted", onMouseDown: onClearLogs },
              { text: "open folder", tone: "primary", onMouseDown: onOpenExports },
            ]}
          />
          <LogFilterBar
            palette={palette}
            logs={filterBarLogs}
            names={logSources ?? names}
            service={service}
            errorOnly={errorOnly}
            width={width}
            onService={onService}
            onToggleErrors={onToggleErrors}
          />
        </>
      )}
      {searchFocused ? (
        <box height={1} paddingLeft={1} backgroundColor={palette.highlight} overflow="hidden">
          <input
            focused
            value={search}
            placeholder="search messages or service names"
            onInput={onSearch}
            backgroundColor={palette.highlight}
            focusedBackgroundColor={palette.highlight}
            textColor={palette.text}
            cursorColor={palette.primary}
          />
        </box>
      ) : null}
      {view && shownTotal > shown.length ? (
        <LogHistoryBar palette={palette} start={viewStart} count={shown.length} total={shownTotal} />
      ) : null}
      <box
        flexGrow={1}
        border={!fullscreen}
        borderStyle="rounded"
        borderColor={palette.border}
        title={fullscreen ? undefined : `logs  ${scope}  ·  ${rangeLabel}`}
        titleColor={palette.primary}
        padding={fullscreen ? 0 : scale.pad}
        overflow="hidden"
      >
        {shown.length === 0 ? (
          <EmptyState
            palette={palette}
            title={logs.length === 0 ? "No log events" : "No events in this filter"}
            body={logs.length === 0 ? "Start services to stream logs." : "Pick All, another service, or clear search / ERROR+."}
            hint="← → cycle filters   1-9 pick a source   e errors   i internal   ctrl+l clear"
          />
        ) : (
          <LogList
            key={followTick}
            palette={palette}
            logs={shown}
            width={innerWidth}
            followTick={followTick}
            focused={false}
            wrapMode={wrapMode}
            selected={selected}
            follow={follow}
            showTimestamps={props.showTimestamps !== false}
            showMeta={props.showMeta !== false}
            onPick={onSelect}
            onLeaveLatest={onLeaveLatest}
            viewStart={viewStart}
          />
        )}
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints
          palette={palette}
          hints={visibleHints(
            [
              { key: "←→", label: "filter" },
              { key: "1-9", label: "source" },
              { key: "e", label: "errors" },
              { key: "i", label: showSystemLogs ? "internal off" : "internal on" },
              { key: "ctrl+l", label: "clear" },
              { key: "f", label: "search" },
              { key: "j/k", label: "move" },
              { key: "enter", label: "details" },
              { key: "g", label: newer > 0 ? `latest +${newer}` : "latest" },
              { key: "w", label: "wrap" },
              { key: "p", label: "pause" },
              { key: "z", label: fullscreen ? "exit full" : "full screen" },
              { key: "t", label: props.showTimestamps === false ? "time off" : "time" },
              { key: "m", label: props.showMeta === false ? "meta off" : "meta" },
              { key: "pgup/pgdn", label: "history" },
              { key: "/exports", label: "open folder" },
            ],
            Math.max(20, width - 2),
          )}
        />
      </Toolbar>
      {!follow ? (
        <JumpLatestPrompt palette={palette} width={width} newer={newer} onJump={onJumpLatest} />
      ) : null}
    </box>
  );
}

export function LogHistoryBar(props: { palette: Palette; start: number; count: number; total: number }) {
  const end = Math.min(props.total, props.start + props.count);
  const older = Math.max(0, props.start);
  const newer = Math.max(0, props.total - end);
  return (
    <MetaBar
      palette={props.palette}
      items={[
        { text: `view ${props.start + 1}–${end} of ${props.total}`, tone: "primary" },
        { text: older > 0 ? `↑ ${older} older` : "start of history", tone: older > 0 ? "info" : "idle" },
        { text: newer > 0 ? `↓ ${newer} newer` : "at latest", tone: newer > 0 ? "warning" : "success" },
      ]}
      hints={[
        { key: "pgup/pgdn", label: "move history window" },
        { key: "g", label: "latest" },
      ]}
    />
  );
}

export function JumpLatestPrompt(props: { palette: Palette; width: number; newer: number; bottom?: number; onJump?: () => void }) {
  const label = props.newer > 0 ? `g  jump to latest  ·  ${props.newer} new` : "g  jump to latest";
  const promptWidth = Math.min(props.width, label.length + 4);
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((props.width - promptWidth) / 2))}
      bottom={props.bottom ?? 2}
      width={promptWidth}
      height={3}
      border
      borderStyle="rounded"
      borderColor={props.palette.warning}
      backgroundColor={props.palette.panel}
      alignItems="center"
      justifyContent="center"
      onMouseDown={props.onJump}
    >
      <text wrapMode="none">
        <span fg={props.palette.primary}>g</span>
        <span fg={props.palette.text}>{label.slice(1)}</span>
      </text>
    </box>
  );
}

export function LogFilterBar(props: {
  palette: Palette;
  logs: LogEvent[];
  names: string[];
  service: string;
  errorOnly: boolean;
  width: number;
  onService: (service: string) => void;
  onToggleErrors: () => void;
}) {
  const { palette, logs, names, service, errorOnly, width, onService, onToggleErrors } = props;
  const sources = logFilterCatalog(names, logs);
  const compact = width < 80;
  const items = sources.map((item, index) => {
    const slot = index + 1;
    const name = item.name === "" ? "all" : item.name;
    return {
      id: name,
      label: compact ? `${slot} ${name}` : `${slot} ${name} · ${item.count}`,
      color: serviceColor(item.name, palette),
    };
  });
  const active = Math.max(0, sources.findIndex((item) => item.name === service));
  const levelLabel = errorOnly ? "ERROR+" : compact ? "lvls" : "all levels";
  const stripWidth = Math.max(tabChipWidth(items[active]?.label ?? "1 all"), width - tabChipWidth(levelLabel));
  return (
    <Toolbar palette={palette} backgroundColor={palette.element}>
    <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      <box flexGrow={1} overflow="hidden">
        <TabStrip
          palette={palette}
          items={items}
          active={active}
          width={stripWidth}
          onPick={(index) => {
            const item = sources[index];
            if (item) {
              onService(item.name);
            }
          }}
        />
      </box>
      <Chip
        palette={palette}
        label={levelLabel}
        tone={errorOnly ? "error" : "muted"}
        onMouseDown={onToggleErrors}
      />
    </box>
    </Toolbar>
  );
}

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
  } = props;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const alignedSelection = useRef("");
  const slice = limit === undefined ? logs : logs.slice(-limit);
  const serviceNames = [...new Set(logs.map((ev) => ev.service))];
  const serviceWidth = logServiceColumnWidth(width, serviceNames);
  const msgWidth = logMessageWidth({ width, serviceWidth, showTimestamps, showMeta });

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
  }, [follow, followTick]);

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
    const arm = setTimeout(() => {
      armed = true;
    }, FOLLOW_ARM_MS);
    const id = setInterval(() => {
      const box = scrollRef.current;
      if (!armed || !box) {
        return;
      }
      const viewH = box.viewport.height;
      if (viewH > 0 && box.scrollTop + viewH < box.scrollHeight - FOLLOW_SLACK) {
        onLeaveLatest();
      }
    }, FOLLOW_POLL_MS);
    return () => {
      clearTimeout(arm);
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
}) {
  const { id, palette, event, serviceWidth, msgWidth, expanded, active, showTimestamps = true, showMeta = true, onPick } = props;
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
              {lineIndex === 0 ? String(event.level) : ""}
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
            <LogMessage palette={palette} level={event.level} text={line} mark={lineIndex === 0 ? fold.mark : ""} />
          </box>
        </box>
      ))}
    </box>
  );
}

function LogMessage(props: { palette: Palette; level: string; text: string; mark: string }) {
  const { palette, level, text, mark } = props;
  return (
    <text wrapMode="none">
      {logMessageSpans(text).map((span, spanIndex) => (
        <span key={`${span.kind}-${spanIndex}`} fg={logSpanColor(palette, level, span.kind)}>
          {span.text}
        </span>
      ))}
      {mark === "" ? null : <span fg={palette.muted}>{mark}</span>}
    </text>
  );
}
