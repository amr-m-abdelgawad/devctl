import { useEffect, useState } from "react";
import spinners from "cli-spinners";
import { EmptyState, ErrorState } from "../chrome.tsx";
import { renderBar } from "../helpers.ts";
import { ScreenFrame, scrollboxStyle, useScrollSelectedIntoView } from "../layout.tsx";
import { stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type Check, type DoctorProgress, type Report } from "../../doctor.ts";

const ROW_PREFIX = "doctor-row";
// The fixed-width frames keep the centered loading heading stable in every
// terminal, without depending on emoji font support.
const DOCTOR_SPINNER = spinners.bouncingBall;

export function DoctorScreen(props: {
  palette: Palette;
  report?: Report;
  loading: boolean;
  progress: DoctorProgress;
  error?: string;
  selected: number;
  onPick: (index: number) => void;
  onReload: () => void;
}) {
  const { palette, report, loading, progress, error, selected, onPick, onReload } = props;
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
      <box height={1} flexShrink={0} />
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden" gap={1}>
          {report.checks.map((c, i) => (
            <DoctorRow key={`${c.name}-${i}`} palette={palette} check={c} index={i} active={i === selected} onPick={onPick} />
          ))}
        </box>
      </scrollbox>
    </ScreenFrame>
  );
}

function DoctorLoading({ palette, progress }: { palette: Palette; progress: DoctorProgress }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % DOCTOR_SPINNER.frames.length), DOCTOR_SPINNER.interval);
    return () => clearInterval(timer);
  }, []);
  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" overflow="hidden">
      <box
        width="80%"
        maxWidth={52}
        height={10}
        flexShrink={1}
        border
        borderStyle="rounded"
        borderColor={palette.borderActive}
        backgroundColor={palette.panel}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
      >
        <text wrapMode="none">
          <span fg={palette.primary}>{`${DOCTOR_SPINNER.frames[frame]}  `}</span>
          <span fg={palette.text}>devctl doctor</span>
        </text>
        <box height={1} flexShrink={0} />
        <text fg={palette.text} wrapMode="none">{`Checking  ${progress.active}`}</text>
        <box height={1} flexShrink={0} />
        {progress.checks.slice(-4).map((check, index) => (
          <text key={`${check.name}-${index}`} wrapMode="none">
            <span fg={stateColor(palette, check.severity === "error" ? "ERROR" : check.severity === "warn" ? "WARN" : "OK")}>
              {`${stateGlyph(check.severity === "error" ? "ERROR" : check.severity === "warn" ? "WARN" : "OK")} `}
            </span>
            <span fg={palette.muted}>{check.name}</span>
          </text>
        ))}
        {progress.checks.length === 0 ? <text fg={palette.muted}>Waiting for the first result…</text> : null}
      </box>
    </box>
  );
}

function DoctorRow(props: { palette: Palette; check: Check; index: number; active: boolean; onPick: (index: number) => void }) {
  const { palette, check: c, index, active, onPick } = props;
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
      {active && c.action?.kind === "free-port" ? (
        <text fg={palette.primary} wrapMode="none">
          {`enter  stop ${c.action.holder.command} (pid ${c.action.holder.pid})`}
        </text>
      ) : null}
    </box>
  );
}
