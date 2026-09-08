import { type DevctlConfig } from "../../../domain/config/types.ts";
import { type LogEvent,type LogFacets } from "../../../domain/logs/logs.ts";
import { HealthUnhealthy,StateFailed,StateRestarting,type Runtime } from "../../../domain/service/services.ts";
import { type PersistedState } from "../../../domain/session/session.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { NARROW_WIDTH } from "../helpers/chrome.ts";
import { clipText,padClip } from "../helpers/format.ts";
import { filterLogs,isSystemLogSource,visibleLogErrorCount,type LogWrapMode } from "../helpers/logs.ts";
import { canStartAll,previousSessionNote,serviceLineState,serviceListInnerWidth,serviceListPaneWidth } from "../helpers/services.ts";
import { countRunning } from "../helpers/stats.ts";
import { MetaBar } from "../layout.tsx";
import { serviceColor,stateColor,stateGlyph,type Palette } from "../themes.ts";
import { JumpLatestPrompt, LogFilterBar, LogHistoryBar, LogList } from "../components/logs/index.ts";
import { SelectionHint,ServiceRows } from "./ServiceRows.tsx";

export function Dashboard(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  logs: LogEvent[];
  names: string[];
  selected: number;
  selectedLog?: number;
  checked: string[];
  width: number;
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
  facets?: LogFacets;
  leftover?: PersistedState;
  search?: string;
  regex?: boolean;
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
    width,
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
    facets,
    leftover,
    search = "",
    regex = false,
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
  const logErrors = visibleLogErrorCount(logs);
  const lastSession = idle ? previousSessionNote(leftover, snap?.session_id) : undefined;
  const listWidth = serviceListPaneWidth(width, names, stacked);
  const logWidth = Math.max(24, stacked ? width - 4 : width - listWidth - 4);
  const filterBarLogs = showSystemLogs ? logs : logs.filter((ev) => !isSystemLogSource(ev.source));
  const visible = filterLogs(logs, { service: logService, errorOnly, systemLogs: showSystemLogs, search, regex });
  const shown = view ?? visible;
  const shownTotal = viewTotal ?? visible.length;
  const viewEnd = Math.min(shownTotal, viewStart + shown.length);
  const rangeLabel = shownTotal === 0 ? "empty" : `${viewStart + 1}–${viewEnd} of ${shownTotal}`;
  const scope = logService === "" ? "all" : logService;
  const serviceMeta = [
    ...(counts.running > 0 ? [{ text: `${counts.running}/${names.length}`, tone: "success" as const }] : []),
    ...(failed > 0 ? [{ text: `${failed} failed`, tone: "error" as const }] : []),
    ...(checked.length > 0 ? [{ text: `${checked.length} selected`, tone: "primary" as const }] : []),
    ...(logErrors > 0 ? [{ text: `${logErrors} errors`, tone: "error" as const, onMouseDown: onShowErrors }] : []),
  ];

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
        {serviceMeta.length > 0 ? <MetaBar palette={palette} items={serviceMeta} /> : null}
        <SelectionHint palette={palette} checked={checked} />
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
        {lastSession ? <LastSessionPanel palette={palette} leftover={lastSession} width={listWidth} /> : null}
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
        title={`logs  ·  ${scope}  ·  ${rangeLabel}`}
        titleColor={palette.primary}
        overflow="hidden"
        flexDirection="column"
      >
        <LogFilterBar
          palette={palette}
          logs={filterBarLogs}
          names={logSources ?? names}
          service={logService}
          errorOnly={errorOnly}
          width={logWidth}
          onService={onFilterService}
          onToggleErrors={onToggleErrors}
          facets={facets}
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
            hint="← → cycle service   e errors   g latest"
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
            search={search}
            regex={regex}
          />
        )}
        {!follow ? <JumpLatestPrompt palette={palette} width={logWidth} newer={newer} bottom={0} onJump={onJumpLatest} /> : null}
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
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} overflow="hidden">
      <box height={1} overflow="hidden">
        <text fg={palette.error} wrapMode="none">
          {`issues (${rows.length})`}
        </text>
      </box>
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

const LAST_SESSION_MAX_ROWS = 4;
const LAST_SESSION_NAME_COL = 14;

function LastSessionPanel(props: { palette: Palette; leftover: PersistedState; width: number }) {
  const { palette, leftover, width } = props;
  const shown = leftover.processes.slice(0, LAST_SESSION_MAX_ROWS);
  const hidden = leftover.processes.length - shown.length;
  const pidWidth = Math.max(8, width - LAST_SESSION_NAME_COL - 4);
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} overflow="hidden">
      <box height={1} overflow="hidden">
        <text fg={palette.warning} wrapMode="none">
          last session
        </text>
      </box>
      <text fg={palette.muted} wrapMode="none">
        {clipText(`${leftover.session_id}  ${leftover.profile || "(none)"}`, Math.max(8, width - 4))}
      </text>
      {shown.map((proc) => (
        <box key={`${proc.name}-${proc.pid}`} height={1} flexDirection="row" overflow="hidden">
          <box width={LAST_SESSION_NAME_COL} flexShrink={0} overflow="hidden">
            <text fg={palette.text} wrapMode="none">
              {padClip(proc.name, LAST_SESSION_NAME_COL)}
            </text>
          </box>
          <box width={pidWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.muted} wrapMode="none">
              {clipText(`pid ${proc.pid}  leftover`, pidWidth)}
            </text>
          </box>
        </box>
      ))}
      {hidden > 0 ? (
        <text fg={palette.muted} wrapMode="none">
          {`+${hidden} more leftover pids`}
        </text>
      ) : null}
    </box>
  );
}
