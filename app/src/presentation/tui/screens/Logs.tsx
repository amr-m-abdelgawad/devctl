import { type LogEvent,type LogFacets } from "../../../domain/logs/logs.ts";
import { JumpLatestPrompt, LogFilterBar, LogHistoryBar, LogList } from "../components/logs/index.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { filterLogs, isSystemLogSource, logPaneInnerWidth, type LogWrapMode } from "../helpers/logs.ts";
import { MetaBar } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { displayWithMod } from "../tui-config.ts";

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
    wrapMode = "all",
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
            hint={`← → cycle filters   e errors   i internal   ${displayWithMod("l")} clear`}
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

