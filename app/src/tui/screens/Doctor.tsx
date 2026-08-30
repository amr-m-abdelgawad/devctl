import { EmptyState, ErrorState, LoadingState } from "../chrome.tsx";
import { ScreenFrame, scrollboxStyle, useScrollSelectedIntoView } from "../layout.tsx";
import { stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type Report } from "../../doctor.ts";

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
  return (
    <ScreenFrame palette={palette} title={`doctor  ${report.issues} issue(s)`}>
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          {report.checks.map((c, i) => {
            const state = c.severity === "error" ? "ERROR" : c.severity === "warn" ? "WARN" : "OK";
            const active = i === selected;
            return (
              <box
                id={`${ROW_PREFIX}-${i}`}
                key={`${c.name}-${i}`}
                flexDirection="column"
                marginBottom={1}
                paddingLeft={1}
                backgroundColor={active ? palette.highlight : undefined}
                onMouseDown={() => onPick(i)}
              >
                <text>
                  <span fg={palette.primary}>{active ? "› " : "  "}</span>
                  <span fg={stateColor(palette, state)}>{stateGlyph(state)}</span>
                  <span fg={active ? palette.primary : palette.text}>{` ${c.name}`}</span>
                </text>
                {c.severity !== "ok" ? <text fg={palette.text}>{`    ${c.message}`}</text> : null}
                {c.hint ? <text fg={palette.info}>{`    → ${c.hint}`}</text> : null}
                {active && c.action?.kind === "free-port" ? (
                  <text fg={palette.primary}>{`    enter  stop ${c.action.holder.command} (pid ${c.action.holder.pid})`}</text>
                ) : null}
              </box>
            );
          })}
        </box>
      </scrollbox>
    </ScreenFrame>
  );
}
