import { EmptyState, ErrorState, LoadingState } from "../chrome.tsx";
import { ScreenFrame, scrollboxStyle, useScrollSelectedIntoView } from "../layout.tsx";
import { stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type Check, type Report } from "../../doctor.ts";

const ROW_PREFIX = "doctor-row";

export function DoctorScreen(props: {
  palette: Palette;
  report?: Report;
  loading: boolean;
  error?: string;
  selected: number;
  onPick: (index: number) => void;
}) {
  const { palette, report, loading, error, selected, onPick } = props;
  const scrollRef = useScrollSelectedIntoView(selected, ROW_PREFIX);
  if (loading) {
    return <LoadingState palette={palette} label="Running doctor…" />;
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
  const barLen = 20;
  const filled = total > 0 ? Math.round((okCount / total) * barLen) : 0;
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
  const barColor = errorCount > 0 ? palette.error : warnCount > 0 ? palette.warning : palette.success;
  return (
    <ScreenFrame palette={palette} title={`doctor  ${report.issues} issue(s)`}>
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
