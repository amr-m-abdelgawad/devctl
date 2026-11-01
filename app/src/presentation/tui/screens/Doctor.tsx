import { GhostLoader } from "../components/GhostLoader.tsx";
import { busyPortHolders, FREE_ALL_PORT_MINIMUM } from "../../../domain/doctor/report.ts";
import { type Check,type DoctorProgress,type Report } from "../../../domain/doctor/types.ts";
import type { PortHolder } from "../../../domain/net/ports.ts";
import { EmptyState,ErrorState } from "../chrome.tsx";
import { renderBar } from "../helpers/format.ts";
import { ScreenFrame,scrollboxStyle,useScrollSelectedIntoView } from "../layout.tsx";
import { stateColor,stateGlyph,type Palette } from "../themes.ts";

const ROW_PREFIX = "doctor-row";

export function DoctorScreen(props: {
  palette: Palette;
  report?: Report;
  loading: boolean;
  progress: DoctorProgress;
  error?: string;
  selected: number;
  onPick: (index: number) => void;
  onReload: () => void;
  onFreePort: (holder: PortHolder) => void;
  onFreeAll: () => void;
}) {
  const { palette, report, loading, progress, error, selected, onPick, onReload, onFreePort, onFreeAll } = props;
  const scrollRef = useScrollSelectedIntoView(selected, ROW_PREFIX);
  if (loading) {
    return <DoctorLoading palette={palette} progress={progress} />;
  }
  if (error) {
    return <ErrorState palette={palette} title="Doctor failed" body={error} />;
  }
  if (!report) {
    return <EmptyState palette={palette} title="Doctor" body="Diagnostics have not run yet." hint="opening this screen runs doctor" />;
  }
  const okCount = report.checks.filter((c) => c.severity === "ok").length;
  const warnCount = report.checks.filter((c) => c.severity === "warn").length;
  const errorCount = report.checks.filter((c) => c.severity === "error").length;
  const busyPorts = busyPortHolders(report.checks);
  const total = report.checks.length;
  const bar = renderBar(total > 0 ? okCount / total : 0);
  const barColor = errorCount > 0 ? palette.error : warnCount > 0 ? palette.warning : palette.success;
  return (
    <ScreenFrame palette={palette} title={`doctor  ${report.issues} issue(s)`}>
      <box
        height={4}
        flexDirection="column"
        flexShrink={0}
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        border
        borderStyle="rounded"
        borderColor={palette.primary}
        backgroundColor={palette.element}
        onMouseDown={onReload}
      >
        <text wrapMode="none">
          <span fg={palette.inverse} bg={palette.primary}>{"  r  "}</span>
          <span fg={palette.primary}>{"  RUN DOCTOR AGAIN"}</span>
        </text>
        <text fg={palette.muted} wrapMode="none">results stay cached until you refresh</text>
      </box>
      <box height={1} flexShrink={0} />
      <box height={1} flexShrink={0} overflow="hidden">
        <text wrapMode="none">
          <span fg={barColor}>{`[${bar}]`}</span>
          <span fg={palette.success}>{`  ${okCount} ok`}</span>
          {warnCount > 0 ? <span fg={palette.warning}>{`  ·  ${warnCount} warn`}</span> : null}
          {errorCount > 0 ? <span fg={palette.error}>{`  ·  ${errorCount} error`}</span> : null}
          {warnCount === 0 && errorCount === 0 ? <span fg={palette.muted}>{"  ·  all clear"}</span> : null}
        </text>
      </box>
      {busyPorts.length >= FREE_ALL_PORT_MINIMUM ? <box height={1} flexShrink={0} /> : null}
      {busyPorts.length >= FREE_ALL_PORT_MINIMUM ? (
        <box height={1} flexShrink={0} overflow="hidden" onMouseDown={onFreeAll}>
          <text wrapMode="none">
            <span fg={palette.inverse} bg={palette.error}>{"  f  "}</span>
            <span fg={palette.error}>{`  FREE ALL ${busyPorts.length} BUSY PORTS`}</span>
          </text>
        </box>
      ) : null}
      <box height={1} flexShrink={0} />
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette, { gap: 1 })}>
          {report.checks.map((c, i) => (
            <DoctorRow
              key={`${c.name}-${i}`}
              palette={palette}
              check={c}
              index={i}
              active={i === selected}
              onPick={onPick}
              onFree={onFreePort}
            />
          ))}
      </scrollbox>
    </ScreenFrame>
  );
}

function DoctorLoading({ palette, progress }: { palette: Palette; progress: DoctorProgress }) {
  const warnings = progress.checks.filter((check) => check.severity === "warn").length;
  const errors = progress.checks.filter((check) => check.severity === "error").length;
  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" overflow="hidden">
      <box
        width="90%"
        maxWidth={66}
        height={18}
        maxHeight="100%"
        flexShrink={1}
        border
        borderStyle="rounded"
        borderColor={palette.borderActive}
        title=" environment diagnostics "
        titleColor={palette.primary}
        backgroundColor={palette.panel}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
        overflow="hidden"
      >
        <box height={9} minHeight={3} flexShrink={1} flexDirection="row" alignItems="center" overflow="hidden">
          <box width={18} flexShrink={0} alignItems="center" justifyContent="center" overflow="hidden">
            <GhostLoader palette={palette} />
          </box>
          <box flexGrow={1} minWidth={0} flexDirection="column" justifyContent="center" overflow="hidden">
            <text height={1} flexShrink={0} fg={palette.text} wrapMode="none">devctl doctor</text>
            <text height={1} flexShrink={0} fg={palette.muted} wrapMode="none">Scanning your environment</text>
            <box height={1} flexShrink={0} />
            <text height={1} flexShrink={0} fg={palette.primary} wrapMode="none">CHECKING</text>
            <text height={2} flexShrink={0} fg={palette.text} wrapMode="word">{progress.active}</text>
          </box>
        </box>
        <box height={1} flexShrink={0} />
        <text height={1} flexShrink={0} wrapMode="none">
          <span fg={palette.text}>{`${progress.checks.length} completed`}</span>
          <span fg={palette.muted}>{"  ·  "}</span>
          <span fg={warnings ? palette.warning : palette.muted}>{`${warnings} warn`}</span>
          <span fg={palette.muted}>{"  ·  "}</span>
          <span fg={errors ? palette.error : palette.muted}>{`${errors} error`}</span>
        </text>
        <box height={1} flexShrink={0} />
        <box
          flexGrow={1}
          minHeight={2}
          border={["top"]}
          borderColor={palette.border}
          title=" latest checks "
          titleColor={palette.muted}
          flexDirection="column"
          overflow="hidden"
        >
          {progress.checks.slice(-3).map((check, index) => (
            <text key={`${check.name}-${index}`} height={1} flexShrink={0} wrapMode="none">
              <span fg={stateColor(palette, check.severity === "error" ? "ERROR" : check.severity === "warn" ? "WARN" : "OK")}>
                {`${stateGlyph(check.severity === "error" ? "ERROR" : check.severity === "warn" ? "WARN" : "OK")} `}
              </span>
              <span fg={palette.muted}>{check.name}</span>
            </text>
          ))}
          {progress.checks.length === 0 ? <text height={1} flexShrink={0} fg={palette.muted}>Waiting for the first result…</text> : null}
        </box>
      </box>
    </box>
  );
}

function DoctorRow(props: {
  palette: Palette;
  check: Check;
  index: number;
  active: boolean;
  onPick: (index: number) => void;
  onFree: (holder: PortHolder) => void;
}) {
  const { palette, check: c, index, active, onPick, onFree } = props;
  const holder = c.severity === "error" && c.action?.kind === "free-port" ? c.action.holder : undefined;
  const state = c.severity === "error" ? "ERROR" : c.severity === "warn" ? "WARN" : "OK";
  const isIssue = c.severity !== "ok";
  if (!isIssue) {
    return (
      <box
        id={`${ROW_PREFIX}-${index}`}
        flexDirection="row"
        flexShrink={0}
        paddingLeft={1}
        overflow="hidden"
        backgroundColor={active ? palette.highlight : undefined}
        onMouseDown={() => onPick(index)}
      >
        <text wrapMode="none">
          <span fg={palette.primary}>{active ? "› " : "  "}</span>
          <span fg={stateColor(palette, state)}>{stateGlyph(state)}</span>
          <span fg={active ? palette.primary : palette.text}>{` ${c.name}`}</span>
          <span fg={palette.muted}>{c.message ? `  ·  ${c.message}` : ""}</span>
        </text>
      </box>
    );
  }
  const borderColor = c.severity === "error" ? palette.error : palette.warning;
  return (
    <box
      id={`${ROW_PREFIX}-${index}`}
      border
      borderStyle="rounded"
      borderColor={active ? palette.borderActive : borderColor}
      title={c.name}
      titleColor={borderColor}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
      backgroundColor={active ? palette.highlight : undefined}
      onMouseDown={() => onPick(index)}
    >
      <text wrapMode="word">
        <span fg={stateColor(palette, state)}>{`${stateGlyph(state)} `}</span>
        <span fg={palette.text}>{c.message}</span>
      </text>
      {c.hint ? (
        <text fg={palette.info} wrapMode="word">
          {`→ ${c.hint}`}
        </text>
      ) : null}
      {holder ? (
        <box flexShrink={0} onMouseDown={() => onFree(holder)}>
          <text wrapMode="none">
            <span fg={palette.inverse} bg={palette.error}>{" free "}</span>
            <span fg={palette.muted}>{`  stop ${holder.command} (pid ${holder.pid})${active ? "   ·  enter" : ""}`}</span>
          </text>
        </box>
      ) : null}
    </box>
  );
}
