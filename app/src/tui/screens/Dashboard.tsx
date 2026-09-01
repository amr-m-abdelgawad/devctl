import { canStartAll, clipText, countRunning, defaultProfileName, filterLogs, formatUptime, googleProjectDisplay, isSystemLogSource, NARROW_WIDTH, padClip, profileMembers, runningLabel, serviceListInnerWidth, serviceListPaneWidth, serviceLineState, statusStripChips, visibleHints, visibleLogErrorCount, type LogWrapMode } from "../helpers.ts";
import { useDensity } from "../density.tsx";
import { Chip, KeyHints, MetaBar, Toolbar } from "../layout.tsx";
import { EmptyState } from "../chrome.tsx";
import { serviceColor, stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type GoogleStatus } from "../../google.ts";
import { type LogEvent } from "../../logs.ts";
import { HealthUnhealthy, StateFailed, StateRestarting, type Runtime } from "../../services.ts";
import { sessionStartedAt } from "../../storage.ts";
import { type StatusSnapshot } from "../../types.ts";
import { SelectionHint, ServiceRows } from "./ServiceRows.tsx";
import { JumpLatestPrompt, LogFilterBar, LogHistoryBar, LogList } from "./Logs.tsx";

export function Dashboard(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  logs: LogEvent[];
  names: string[];
  selected: number;
  selectedLog?: number;
  checked: string[];
  profile: string;
  google?: GoogleStatus;
  width: number;
  paused: boolean;
  followTick: number;
  logService: string;
  logSources?: string[];
  errorOnly: boolean;
  showSystemLogs: boolean;
  onOpen: (name: string) => void;
  onSelectIndex: (index: number) => void;
  onToggle: (name: string) => void;
  onFilterService: (service: string) => void;
  onToggleErrors: () => void;
  onToggleSystemLogs: () => void;
  onClearLogs: () => void;
  onShowErrors?: () => void;
  wrapMode?: LogWrapMode;
  view?: LogEvent[];
  follow?: boolean;
  onLeaveLatest?: () => void;
  onPickLog?: (index: number) => void;
  viewStart?: number;
  viewTotal?: number;
  newer?: number;
  onJumpLatest?: () => void;
}) {
  const {
    palette,
    cfg,
    snap,
    logs,
    names,
    selected,
    selectedLog = -1,
    checked,
    profile,
    google,
    width,
    paused,
    followTick,
    logService,
    logSources,
    errorOnly,
    showSystemLogs,
    onOpen,
    onSelectIndex,
    onToggle,
    onFilterService,
    onToggleErrors,
    onToggleSystemLogs,
    onClearLogs,
    onShowErrors,
    wrapMode = "clip",
    view,
    follow = true,
    onLeaveLatest,
    onPickLog,
    viewStart = 0,
    viewTotal,
    newer = 0,
    onJumpLatest,
  } = props;
  const scale = useDensity();
  if (!cfg || names.length === 0) {
    return (
      <EmptyState
        palette={palette}
        title="No services configured"
        body="Add services to .devctl/config.yaml or finish setup."
        hint="open the setup screen with /setup"
      />
    );
  }
  const stacked = width < NARROW_WIDTH;
  const idle = canStartAll(snap);
  const counts = countRunning(snap, names);
  const failed = names.filter((name) => snap?.services[name]?.state === "FAILED").length;
  const sessionStart = snap?.session_id ? sessionStartedAt(snap.session_id) : undefined;
  const uptime = sessionStart ? formatUptime(Date.now() - sessionStart.getTime()) : undefined;
  const logErrors = visibleLogErrorCount(logs);
  const profileName = profile || defaultProfileName(cfg);
  const members = profileMembers(cfg, profileName);
  const listWidth = serviceListPaneWidth(width, names, stacked);
  const logWidth = Math.max(24, stacked ? width - 4 : width - listWidth - 4);
  const filterBarLogs = showSystemLogs ? logs : logs.filter((ev) => !isSystemLogSource(ev.source));
  const visible = filterLogs(logs, { service: logService, errorOnly, systemLogs: showSystemLogs });
  const shown = view ?? visible;
  const shownTotal = viewTotal ?? visible.length;
  const viewEnd = Math.min(shownTotal, viewStart + shown.length);
  const rangeLabel = shownTotal === 0 ? "empty" : `${viewStart + 1}–${viewEnd} of ${shownTotal}`;
  const scope = logService === "" ? "all services" : logService;

  return (
    <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden">
      <box
        flexGrow={stacked ? 1 : 0}
        flexShrink={0}
        minWidth={stacked ? undefined : listWidth}
        width={stacked ? undefined : listWidth}
        border
        borderStyle="rounded"
        borderColor={idle ? palette.border : palette.borderActive}
        backgroundColor={palette.panel}
        title="services"
        titleColor={palette.primary}
        flexDirection="column"
        overflow="hidden"
      >
        <MetaBar
          palette={palette}
          items={[
            { text: runningLabel(counts.running, names.length), tone: counts.running > 0 ? "success" : "idle" },
            ...(failed > 0 ? [{ text: `${failed} failed`, tone: "error" as const }] : []),
            ...(checked.length > 0 ? [{ text: `${checked.length} selected`, tone: "primary" as const }] : []),
            ...(uptime !== undefined ? [{ text: `up ${uptime}`, tone: "idle" as const }] : []),
            ...(logErrors > 0 ? [{ text: `${logErrors} errors`, tone: "error" as const, onMouseDown: onShowErrors }] : []),
          ]}
        />
        <SelectionHint palette={palette} checked={checked} idle={idle} profileName={profileName} members={members} />
        <box flexGrow={1} paddingLeft={scale.pad} paddingRight={scale.pad} overflow="hidden">
          <ServiceRows
            palette={palette}
            names={names}
            snap={snap}
            selected={selected}
            checked={checked}
            width={serviceListInnerWidth(listWidth, scale.pad)}
            onOpen={onOpen}
            onSelectIndex={onSelectIndex}
            onToggle={onToggle}
          />
        </box>
        <IssuesPanel palette={palette} names={names} snap={snap} width={listWidth} onOpen={onOpen} />
        <StatusStrip palette={palette} cfg={cfg} snap={snap} google={google} width={listWidth} />
      </box>
      <box
        position="relative"
        flexGrow={2}
        minWidth={stacked ? undefined : 32}
        minHeight={stacked ? 8 : undefined}
        border
        borderStyle="rounded"
        borderColor={palette.border}
        backgroundColor={palette.panel}
        title={`logs  ·  ${rangeLabel}`}
        titleColor={palette.primary}
        overflow="hidden"
        flexDirection="column"
      >
        <MetaBar
          palette={palette}
          items={[
            { text: paused ? "PAUSED" : "LIVE", tone: paused ? "warning" : "success" },
            { text: `shown ${visible.length}`, tone: "info" },
            { text: `total ${logs.length}` },
            { text: scope, tone: logService === "" ? "idle" : "primary" },
            { text: errorOnly ? "ERROR+" : "all levels", tone: errorOnly ? "error" : "idle", onMouseDown: onToggleErrors },
            { text: showSystemLogs ? "system: on" : "system: off", tone: showSystemLogs ? "accent" : "idle", onMouseDown: onToggleSystemLogs },
            { text: "clear", tone: "muted", onMouseDown: onClearLogs },
          ]}
        />
        <LogFilterBar
          palette={palette}
          logs={filterBarLogs}
          names={logSources ?? names}
          service={logService}
          errorOnly={errorOnly}
          width={logWidth}
          onService={onFilterService}
          onToggleErrors={onToggleErrors}
        />
        {shownTotal > shown.length ? (
          <LogHistoryBar palette={palette} start={viewStart} count={shown.length} total={shownTotal} />
        ) : null}
        {visible.length === 0 ? (
          <EmptyState
            palette={palette}
            title={idle ? "Waiting for logs" : logs.length === 0 ? "No events yet" : "No events in this filter"}
            body={
              idle
                ? "Start services to stream output here. Later starts keep earlier logs."
                : logs.length === 0
                  ? "New lines appear as services write output."
                  : "Click All or another service chip, or turn off ERROR+."
            }
            hint="[ ] cycle service   g  jump to latest"
          />
        ) : (
          <LogList
            key={followTick}
            palette={palette}
            logs={shown}
            width={logWidth}
            followTick={followTick}
            focused={false}
            wrapMode={wrapMode}
            selected={selectedLog}
            follow={follow}
            onLeaveLatest={onLeaveLatest}
            onPick={onPickLog}
            viewStart={viewStart}
          />
        )}
        <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
          <KeyHints
            palette={palette}
            hints={visibleHints(
              [
                { key: "e", label: "errors" },
                { key: "i", label: showSystemLogs ? "internal off" : "internal on" },
                { key: "ctrl+l", label: "clear" },
                { key: "g", label: "latest" },
                { key: "z", label: "full logs" },
                { key: "←→", label: "filter" },
              ],
              Math.max(20, logWidth - 2),
            )}
          />
        </Toolbar>
        {!follow ? <JumpLatestPrompt palette={palette} width={logWidth} newer={newer} bottom={1} onJump={onJumpLatest} /> : null}
      </box>
    </box>
  );
}

const ISSUES_MAX_ROWS = 4;
const ISSUE_NAME_COL = 14;

function needsAttention(rt?: Runtime): boolean {
  if (!rt) {
    return false;
  }
  return rt.state === StateFailed || rt.health === HealthUnhealthy || rt.state === StateRestarting || rt.restarts > 0 || rt.last_error !== "";
}

function issueSeverity(rt: Runtime): number {
  if (rt.state === StateFailed) {
    return 0;
  }
  if (rt.health === HealthUnhealthy) {
    return 1;
  }
  if (rt.state === StateRestarting) {
    return 2;
  }
  return 3;
}

function issueMessage(rt: Runtime): string {
  if (rt.last_error !== "") {
    return rt.last_error;
  }
  if (rt.restarts > 0) {
    return `restarted ${rt.restarts}x, no error recorded`;
  }
  return rt.health === HealthUnhealthy ? "failing health check" : rt.state.toLowerCase();
}

function IssuesPanel(props: { palette: Palette; names: string[]; snap?: StatusSnapshot; width: number; onOpen: (name: string) => void }) {
  const { palette, names, snap, width, onOpen } = props;
  const rows = names
    .map((name) => ({ name, rt: snap?.services[name] }))
    .filter((row): row is { name: string; rt: Runtime } => needsAttention(row.rt))
    .sort((a, b) => issueSeverity(a.rt) - issueSeverity(b.rt));
  if (rows.length === 0) {
    return null;
  }
  const shown = rows.slice(0, ISSUES_MAX_ROWS);
  const hidden = rows.length - shown.length;
  const msgWidth = Math.max(8, width - ISSUE_NAME_COL - 4);
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={palette.error}
      title={`issues (${rows.length})`}
      titleColor={palette.error}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      {shown.map(({ name, rt }) => {
        const state = serviceLineState(rt);
        return (
        <box key={name} height={1} flexDirection="row" overflow="hidden" onMouseDown={() => onOpen(name)}>
          <box width={2} flexShrink={0}>
            <text fg={stateColor(palette, state)}>{stateGlyph(state)}</text>
          </box>
          <box width={ISSUE_NAME_COL} flexShrink={0} overflow="hidden">
            <text fg={serviceColor(name, palette)} wrapMode="none">
              {padClip(name, ISSUE_NAME_COL)}
            </text>
          </box>
          <box width={msgWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.muted} wrapMode="none">
              {clipText(issueMessage(rt), msgWidth)}
            </text>
          </box>
        </box>
        );
      })}
      {hidden > 0 ? (
        <text fg={palette.muted} wrapMode="none">
          {`+${hidden} more — open a service to see details`}
        </text>
      ) : null}
    </box>
  );
}

function StatusStrip(props: {
  palette: Palette;
  cfg: DevctlConfig;
  snap?: StatusSnapshot;
  google?: GoogleStatus;
  width: number;
}) {
  const { palette, cfg, snap, google, width } = props;
  const email = google?.userEmail;
  const project = googleProjectDisplay(cfg, snap?.identity, google).project;
  const logsTotal = snap?.logs.total ?? 0;
  const chips = statusStripChips(email, project, logsTotal, width);
  return (
    <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
      <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
        {chips.map((chip, i) => (
          <Chip key={`${chip.label}-${i}`} palette={palette} label={chip.label} tone={chip.tone} />
        ))}
      </box>
    </Toolbar>
  );
}
