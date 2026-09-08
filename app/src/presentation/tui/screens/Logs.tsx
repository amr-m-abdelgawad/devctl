import { type ScrollBoxRenderable } from "@opentui/core";
import { useEffect,useRef } from "react";
import { type LogEvent,type LogFacets } from "../../../domain/logs/logs.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { padClip } from "../helpers/format.ts";
import { displayLogLevel,facetFilterCatalog,filterLogs,foldLogLines,isSystemLogSource,LOG_COL_GAP,LOG_LEVEL_COL,LOG_META_COL,LOG_TIME_COL,logFilterCatalog,logMessageSpans,logMessageWidth,logPaneInnerWidth,logRowExpanded,logServiceColumnWidth,wrapLogMessage,type LogWrapMode } from "../helpers/logs.ts";
import { tabChipWidth } from "../helpers/navigation.ts";
import { Chip,MetaBar,TabStrip,Toolbar } from "../layout.tsx";
import { logSpanColor,serviceColor,stateColor,type Palette } from "../themes.ts";

const FOLLOW_POLL_MS = 200;
const FOLLOW_SLACK = 2;

export function LogsScreen(props: {
  palette: Palette;
  logs: LogEvent[];
  names: string[];
  logSources?: string[];
  service: string;
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
  facets?: LogFacets;
  onSearch: (value: string) => void;
  onService: (service: string) => void;
  onToggleErrors: () => void;
  onSelect?: (index: number) => void;
  onLeaveLatest?: () => void;
  onJumpLatest?: () => void;
  fullscreen?: boolean;
  split?: boolean;
  splitFocus?: 0 | 1;
  serviceB?: string;
  viewB?: LogEvent[];
  selectedB?: number;
  followB?: boolean;
  newerB?: number;
  viewStartB?: number;
  viewTotalB?: number;
  onServiceB?: (service: string) => void;
  onSelectB?: (index: number) => void;
  onLeaveLatestB?: () => void;
  onFocusPane?: (pane: 0 | 1) => void;
}) {
  const {
    palette,
    logs,
    names,
    logSources,
    service,
    errorOnly,
    showSystemLogs,
    search,
    searchFocused,
    followTick,
    width,
    onSearch,
    onService,
    onToggleErrors,
    onSelect,
    wrapMode = "focus",
    selected = -1,
    follow = true,
    newer = 0,
    viewStart = 0,
    viewTotal,
    onLeaveLatest,
    onJumpLatest,
    view,
    fullscreen = false,
    facets,
    split = false,
    splitFocus = 0,
    serviceB = "",
    viewB,
    selectedB = -1,
    followB = true,
    newerB = 0,
    viewStartB = 0,
    viewTotalB,
    onServiceB,
    onSelectB,
    onLeaveLatestB,
    onFocusPane,
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
  const logMeta = [
    ...(follow ? [] : [{ text: newer > 0 ? `${split ? "left " : ""}pinned · +${newer} new` : `${split ? "left " : ""}pinned`, tone: "warning" as const }]),
    ...(split && !followB ? [{ text: newerB > 0 ? `right pinned · +${newerB} new` : "right pinned", tone: "warning" as const }] : []),
    ...(props.source ? [{ text: `src ${props.source}`, tone: "info" as const }] : []),
    ...(props.regex ? [{ text: "regex", tone: "accent" as const }] : []),
    ...(search === "" ? [] : [{ text: `search ${search}`, tone: "accent" as const }]),
    ...(split ? [{ text: splitFocus === 0 ? "left pane" : "right pane", tone: "accent" as const }] : []),
  ];
  if (split) {
    const leftWidth = Math.max(20, Math.floor(width / 2));
    const rightWidth = Math.max(20, width - leftWidth);
    const shownB = viewB ?? [];
    const totalB = viewTotalB ?? shownB.length;
    return (
      <box flexGrow={1} flexDirection="column" overflow="hidden">
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
        ) : (
          <MetaBar palette={palette} items={logMeta} />
        )}
        <box flexGrow={1} flexDirection="row" overflow="hidden">
          <SplitLogPane
            palette={palette}
            names={logSources ?? names}
            logs={logs}
            service={service}
            errorOnly={errorOnly}
            showSystemLogs={showSystemLogs}
            search={search}
            regex={props.regex}
            source={props.source}
            width={leftWidth}
            shown={shown}
            shownTotal={shownTotal}
            selected={selected}
            follow={follow}
            newer={newer}
            viewStart={viewStart}
            wrapMode={wrapMode}
            showTimestamps={props.showTimestamps !== false}
            showMeta={props.showMeta !== false}
            followTick={followTick}
            facets={facets}
            focused={splitFocus === 0}
            onService={onService}
            onToggleErrors={onToggleErrors}
            onSelect={onSelect}
            onLeaveLatest={onLeaveLatest}
            onFocus={() => onFocusPane?.(0)}
          />
          <SplitLogPane
            palette={palette}
            names={logSources ?? names}
            logs={logs}
            service={serviceB}
            errorOnly={errorOnly}
            showSystemLogs={showSystemLogs}
            search={search}
            regex={props.regex}
            source={props.source}
            width={rightWidth}
            shown={shownB}
            shownTotal={totalB}
            selected={selectedB}
            follow={followB}
            newer={newerB}
            viewStart={viewStartB}
            wrapMode={wrapMode}
            showTimestamps={props.showTimestamps !== false}
            showMeta={props.showMeta !== false}
            followTick={followTick}
            facets={facets}
            focused={splitFocus === 1}
            onService={onServiceB ?? onService}
            onToggleErrors={onToggleErrors}
            onSelect={onSelectB}
            onLeaveLatest={onLeaveLatestB}
            onFocus={() => onFocusPane?.(1)}
          />
        </box>
        {!follow || !followB ? (
          <JumpLatestPrompt palette={palette} width={width} newer={Math.max(newer, newerB)} onJump={onJumpLatest} />
        ) : null}
      </box>
    );
  }
  return (
    <box flexGrow={1} flexDirection="column" overflow="hidden">
      {fullscreen ? null : (
        <>
          {logMeta.length > 0 ? <MetaBar palette={palette} items={logMeta} /> : null}
          <LogFilterBar
            palette={palette}
            logs={filterBarLogs}
            names={logSources ?? names}
            service={service}
            errorOnly={errorOnly}
            width={width}
            onService={onService}
            onToggleErrors={onToggleErrors}
            facets={facets}
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
            hint="← → cycle filters   e errors   i internal   ctrl+l clear"
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
            search={search}
            regex={props.regex === true}
          />
        )}
      </box>
      {!follow ? (
        <JumpLatestPrompt palette={palette} width={width} newer={newer} onJump={onJumpLatest} />
      ) : null}
    </box>
  );
}

function SplitLogPane(props: {
  palette: Palette;
  names: string[];
  logs: LogEvent[];
  service: string;
  errorOnly: boolean;
  showSystemLogs: boolean;
  search: string;
  regex?: boolean;
  source?: string;
  width: number;
  shown: LogEvent[];
  shownTotal: number;
  selected: number;
  follow: boolean;
  newer: number;
  viewStart: number;
  wrapMode: LogWrapMode;
  showTimestamps: boolean;
  showMeta: boolean;
  followTick: number;
  facets?: LogFacets;
  focused: boolean;
  onService: (service: string) => void;
  onToggleErrors: () => void;
  onSelect?: (index: number) => void;
  onLeaveLatest?: () => void;
  onFocus: () => void;
}) {
  const { palette, width, service, shown, shownTotal, viewStart, focused } = props;
  const filterBarLogs = props.showSystemLogs ? props.logs : props.logs.filter((ev) => !isSystemLogSource(ev.source));
  const scope = service === "" ? "all services" : service;
  const rangeLabel = shownTotal === 0 ? "empty" : `${viewStart + 1}–${Math.min(shownTotal, viewStart + shown.length)} of ${shownTotal}`;
  return (
    <box width={width} flexGrow={0} flexShrink={0} flexDirection="column" overflow="hidden" onMouseDown={props.onFocus}>
      <LogFilterBar
        palette={palette}
        logs={filterBarLogs}
        names={props.names}
        service={service}
        errorOnly={props.errorOnly}
        width={width}
        onService={(name) => {
          props.onFocus();
          props.onService(name);
        }}
        onToggleErrors={() => {
          props.onFocus();
          props.onToggleErrors();
        }}
        facets={props.facets}
      />
      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={focused ? palette.borderActive : palette.border}
        title={`logs  ${scope}  ·  ${rangeLabel}`}
        titleColor={focused ? palette.primary : palette.muted}
        overflow="hidden"
      >
        {shown.length === 0 ? (
          <EmptyState
            palette={palette}
            title="No events in this pane"
            body="Click the pane, then ← → to pick a service."
            hint="\\ split   | focus"
          />
        ) : (
          <LogList
            palette={palette}
            logs={shown}
            width={logPaneInnerWidth(width, 0, false)}
            followTick={props.followTick}
            focused={false}
            wrapMode={props.wrapMode}
            selected={props.selected}
            follow={props.follow}
            showTimestamps={props.showTimestamps}
            showMeta={props.showMeta}
            onPick={(index) => {
              props.onFocus();
              props.onSelect?.(index);
            }}
            onLeaveLatest={props.onLeaveLatest}
            viewStart={viewStart}
            search={props.search}
            regex={props.regex === true}
          />
        )}
      </box>
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
  facets?: LogFacets;
}) {
  const { palette, logs, names, service, errorOnly, width, onService, onToggleErrors, facets } = props;
  const sources = facets ? facetFilterCatalog(names, facets) : logFilterCatalog(names, logs);
  const compact = width < 80;
  const items = sources.map((item) => {
    const name = item.name === "" ? "all" : item.name;
    return {
      id: name,
      label: compact ? name : `${name} · ${item.count}`,
      color: serviceColor(item.name, palette),
    };
  });
  const active = Math.max(0, sources.findIndex((item) => item.name === service));
  const levelLabel = errorOnly ? "ERROR+" : compact ? "lvls" : "all levels";
  const stripWidth = Math.max(tabChipWidth(items[active]?.label ?? "all"), width - tabChipWidth(levelLabel));
  return (
    <Toolbar palette={palette} backgroundColor={palette.element}>
    <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      <box flexGrow={1} overflow="hidden">
        <TabStrip
          palette={palette}
          items={items}
          active={active}
          width={stripWidth}
          emphasis="fill"
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
