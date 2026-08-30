import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { alreadyUpNames, pendingPlanWaves, planHeadline, planNextAction, planOverlayHeight, planRowNote, serviceLineState } from "../helpers.ts";
import { stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type LifecycleKind } from "../types.ts";
import { type Plan } from "../../services.ts";
import { type StatusSnapshot } from "../../types.ts";

const WAVE_HEADER_ROWS = 1;
const CHROME_ROWS = 8;

export function PlanOverlay(props: {
  palette: Palette;
  plan: Plan;
  snap?: StatusSnapshot;
  busy: boolean;
  failed: string;
  kind: LifecycleKind;
  termH?: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onDismiss: () => void;
}) {
  const { palette, plan, snap, busy, failed, kind, termH = 24, scrollRef, onDismiss } = props;
  const running = alreadyUpNames(plan, snap);
  const waves = pendingPlanWaves(plan, snap);
  const names = waves.flat();
  const waveCount = waves.length;
  const contentRows = names.length + running.length + waveCount * WAVE_HEADER_ROWS + CHROME_ROWS + (running.length > 0 ? 1 : 0);
  const height = planOverlayHeight(termH, contentRows);
  const title = planTitle(kind, busy, failed);
  const action = planActionCopy(busy, failed);
  const actionFg = failed || busy ? palette.text : palette.inverse;
  const actionBg = failed ? palette.error : busy ? palette.element : palette.primary;
  return (
    <box
      height={height}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={failed ? palette.error : palette.borderActive}
      titleColor={failed ? palette.error : palette.primary}
      backgroundColor={palette.panel}
      title={title}
      flexDirection="column"
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} overflow="hidden" flexShrink={0}>
        <text fg={palette.primary} wrapMode="none">
          {planHeadline(plan, busy, failed, kind)}
        </text>
      </box>
      <box height={1} overflow="hidden" flexShrink={0}>
        <text fg={palette.muted} wrapMode="none">
          {waveBlurb(kind, waveCount)}
        </text>
      </box>
      {running.length > 0 ? (
        <box height={1} overflow="hidden" flexShrink={0}>
          <text fg={palette.success} wrapMode="none">
            {`already running  ${running.join("  ")}`}
          </text>
        </box>
      ) : null}
      {waves.length === 0 && !busy ? (
        <box height={1} overflow="hidden" flexShrink={0}>
          <text fg={palette.muted} wrapMode="none">
            Nothing new to start — earlier services stay up.
          </text>
        </box>
      ) : null}
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={{ rootOptions: { flexGrow: 1, overflow: "hidden", backgroundColor: palette.panel }, viewportOptions: { backgroundColor: palette.panel }, contentOptions: { backgroundColor: palette.panel } }}>
      {waves.map((wave, waveIdx) => (
        <box key={`wave-${waveIdx}`} flexDirection="column" flexShrink={0} overflow="hidden">
          <box height={1} overflow="hidden">
            <text fg={palette.accent} wrapMode="none">
              {waveLabel(kind, waveIdx)}
            </text>
          </box>
          {wave.map((name) => {
            const rt = snap?.services[name];
            const state = serviceLineState(rt);
            const note = planRowNote(name, plan, snap, kind);
            const isFail = name === failed || state === "FAILED";
            return (
              <box key={name} height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
                <box width={3} flexShrink={0} overflow="hidden">
                  <text fg={stateColor(palette, state)}>{stateGlyph(state)}</text>
                </box>
                <box width={12} flexShrink={0} overflow="hidden">
                  <text fg={isFail ? palette.error : palette.text} wrapMode="none">
                    {name}
                  </text>
                </box>
                <box width={12} flexShrink={0} overflow="hidden">
                  <text fg={stateColor(palette, state)} wrapMode="none">
                    {state}
                  </text>
                </box>
                <box flexGrow={1} overflow="hidden">
                  <text fg={isFail ? palette.error : palette.text} wrapMode="none">
                    {note}
                  </text>
                </box>
              </box>
            );
          })}
        </box>
      ))}
      </scrollbox>
      <box height={1} overflow="hidden" flexShrink={0}>
        <text fg={failed ? palette.error : palette.muted} wrapMode="none">
          {planNextAction(busy, failed, kind)}
        </text>
      </box>
      <box
        height={2}
        flexShrink={0}
        backgroundColor={actionBg}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
        onMouseDown={onDismiss}
      >
        <text fg={actionFg} wrapMode="none">
          {action.primary}
        </text>
        <text fg={actionFg} wrapMode="none">
          {action.secondary}
        </text>
      </box>
    </box>
  );
}

function planTitle(kind: LifecycleKind, busy: boolean, failed: string): string {
  if (failed) {
    return `${kind} failed  ·  esc back`;
  }
  if (kind === "stop") {
    return busy ? "stopping  ·  esc hides" : "stopped  ·  esc back";
  }
  if (kind === "restart") {
    return busy ? "restarting  ·  esc hides" : "restarted  ·  esc back";
  }
  return busy ? "starting  ·  esc hides" : "started  ·  esc back";
}

function planActionCopy(busy: boolean, failed: string): { primary: string; secondary: string } {
  if (busy) {
    return {
      primary: "Working…  esc  hide this panel",
      secondary: "You are not stuck. Hide it anytime — the start/stop keeps running.",
    };
  }
  if (failed) {
    return {
      primary: "enter or esc  back to dashboard",
      secondary: "This panel is waiting on you. Click here or press esc.",
    };
  }
  return {
    primary: "enter or esc  back to dashboard",
    secondary: "This overlay stays until you dismiss it. Click here or press esc.",
  };
}

function waveBlurb(kind: LifecycleKind, waveCount: number): string {
  if (kind === "stop") {
    return waveCount <= 1 ? "These services stop together." : "Dependents stop first so nothing is left hanging.";
  }
  if (kind === "restart") {
    return "Stop in reverse order, then start dependencies first.";
  }
  return waveCount <= 1 ? "These services start together." : `They start in ${waveCount} waves. A failed wave stops the rest.`;
}

function waveLabel(kind: LifecycleKind, waveIdx: number): string {
  if (kind === "stop") {
    return waveIdx === 0 ? `wave ${waveIdx + 1}  stop first` : `wave ${waveIdx + 1}  after wave ${waveIdx} is down`;
  }
  return waveIdx === 0 ? `wave ${waveIdx + 1}  start first` : `wave ${waveIdx + 1}  after wave ${waveIdx} is healthy`;
}
