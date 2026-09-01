import { canStartAll, countRunning, defaultProfileName, filterLogs, formatUptime, googleProjectDisplay, NARROW_WIDTH, profileMembers, runningLabel, serviceListInnerWidth, serviceListPaneWidth, statusStripChips, visibleLogErrorCount, type LogWrapMode } from "../helpers.ts";
import { useDensity } from "../density.tsx";
import { Chip, MetaBar, Toolbar } from "../layout.tsx";
import { EmptyState } from "../chrome.tsx";
import { type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type GoogleStatus } from "../../google.ts";
import { type LogEvent } from "../../logs.ts";
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
  onOpen: (name: string) => void;
  onSelectIndex: (index: number) => void;
  onToggle: (name: string) => void;
  onFilterService: (service: string) => void;
  onToggleErrors: () => void;
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
    onOpen,
    onSelectIndex,
    onToggle,
    onFilterService,
    onToggleErrors,
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
  const visible = filterLogs(logs, { service: logService, errorOnly });
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
          ]}
        />
        <LogFilterBar
          palette={palette}
          logs={logs}
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
        {!follow ? <JumpLatestPrompt palette={palette} width={logWidth} newer={newer} bottom={1} onJump={onJumpLatest} /> : null}
      </box>
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
