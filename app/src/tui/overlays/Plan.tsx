import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import {
  alreadyUpNames,
  firstPort,
  padClip,
  pendingPlanWaves,
  planActionCopy,
  planProgress,
  planRowNote,
  planTitle,
  serviceLineState,
  waveCardTitle,
  waveStatus,
} from "../helpers.ts";
import { Chip, OverlayShell, scrollboxStyle } from "../layout.tsx";
import { serviceColor, stateColor, type Palette } from "../themes.ts";
import { type LifecycleKind } from "../types.ts";
import { type Plan } from "../../services.ts";
import { type StatusSnapshot } from "../../types.ts";

export function PlanOverlay(props: {
  palette: Palette;
  plan: Plan;
  snap?: StatusSnapshot;
  busy: boolean;
  failed: string;
  kind: LifecycleKind;
  termW?: number;
  termH?: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onDismiss: () => void;
}) {
  const { palette, plan, snap, busy, failed, kind, termW = 80, termH = 24, scrollRef, onDismiss } = props;
  const running = alreadyUpNames(plan, snap);
  const waves = pendingPlanWaves(plan, snap);
  const progress = planProgress(plan, snap, kind);
  const title = planTitle(kind, busy, failed, plan.profile);
  const action = planActionCopy(busy, failed);
  const actionFg = failed || busy ? palette.text : palette.inverse;
  const actionBg = failed ? palette.error : busy ? palette.element : palette.primary;

  return (
    <OverlayShell
      palette={palette}
      title={title}
      bottomTitle="enter done  ·  esc hide (runs in background)"
      termW={termW}
      termH={termH}
      preferW={82}
      preferH={22}
      borderColor={failed ? palette.error : busy ? palette.primary : palette.success}
      gap={1}
    >
      {/* 1. Progress Bar & Real-time Metrics */}
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <text wrapMode="none">
          <span fg={palette.muted}>Progress </span>
          <span fg={failed ? palette.error : busy ? palette.primary : palette.success}>
            [{progress.progressBar}]
          </span>
          <span fg={palette.text}>{`  ${progress.ready}/${progress.total} Ready (${progress.percent}%)`}</span>
          <span fg={palette.muted}>{`  ·  Wave ${progress.currentWaveIndex + 1} of ${progress.totalWaves} Active`}</span>
        </text>
      </box>

      {/* 2. Wave Pipeline Stepper Flow */}
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element}>
        {plan.waves.map((wave, idx) => {
          const st = waveStatus(wave, snap, kind);
          const icon = st === "completed" ? "✓" : st === "failed" ? "✗" : st === "active" ? "⏳" : "○";
          const tone = st === "completed" ? "success" : st === "failed" ? "error" : st === "active" ? "primary" : "muted";
          return (
            <box key={`step-${idx}`} flexDirection="row" overflow="hidden" flexShrink={0}>
              <Chip
                palette={palette}
                label={`W${idx + 1} ${icon} (${wave.length})`}
                tone={tone}
              />
              {idx < plan.waves.length - 1 ? (
                <box width={3} flexShrink={0} overflow="hidden">
                  <text fg={palette.muted}> ─►</text>
                </box>
              ) : null}
            </box>
          );
        })}
      </box>

      {/* 3. Already Running Notification (if incremental start) */}
      {(plan.blockers ?? []).length > 0 ? (
        <box height={1} overflow="hidden" flexShrink={0}>
          <text fg={palette.error} wrapMode="none">
            {`✗ Blocked: ${plan.blockers?.map((b) => `${b.name} (${b.message})`).join(", ")}`}
          </text>
        </box>
      ) : null}

      {running.length > 0 ? (
        <box height={1} overflow="hidden" flexShrink={0}>
          <text fg={palette.success} wrapMode="none">
            {`✓ Already running: ${running.join(", ")}`}
          </text>
        </box>
      ) : null}

      {/* 4. Scrollable Wave Cards */}
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden" gap={1}>
          {waves.map((wave, waveIdx) => {
            const st = waveStatus(wave, snap, kind);
            const waveCardBorder =
              st === "completed"
                ? palette.success
                : st === "failed"
                  ? palette.error
                  : st === "active"
                    ? palette.primary
                    : palette.border;
            const waveHeading = waveCardTitle(kind, waveIdx, st);
            return (
              <box
                key={`wave-card-${waveIdx}`}
                border
                borderStyle="rounded"
                borderColor={waveCardBorder}
                title={waveHeading}
                titleColor={
                  st === "completed"
                    ? palette.success
                    : st === "failed"
                      ? palette.error
                      : st === "active"
                        ? palette.primary
                        : palette.muted
                }
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
                overflow="hidden"
              >
                {wave.map((name) => {
                  const rt = snap?.services[name];
                  const state = serviceLineState(rt);
                  const note = planRowNote(name, plan, snap, kind);
                  const isFail = name === failed || state === "FAILED";
                  const port = firstPort(rt);
                  const glyph =
                    isFail
                      ? "✗"
                      : state === "HEALTHY"
                        ? "✓"
                        : state === "STARTING" || state === "RUNNING" || state === "STOPPING" || state === "RESTARTING"
                          ? "●"
                          : "○";
                  const glyphColor = isFail ? palette.error : stateColor(palette, state);
                  return (
                    <box key={name} height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
                      <box width={2} flexShrink={0} overflow="hidden">
                        <text fg={glyphColor}>{glyph}</text>
                      </box>
                      <box width={14} flexShrink={0} overflow="hidden">
                        <text fg={serviceColor(name, palette)} wrapMode="none">
                          {padClip(name, 14)}
                        </text>
                      </box>
                      <box width={11} flexShrink={0} overflow="hidden">
                        <text fg={stateColor(palette, state)} wrapMode="none">
                          {padClip(state, 11)}
                        </text>
                      </box>
                      {port ? (
                        <box width={8} flexShrink={0} overflow="hidden">
                          <text fg={palette.info} wrapMode="none">
                            {padClip(`:${port}`, 8)}
                          </text>
                        </box>
                      ) : (
                        <box width={8} flexShrink={0} overflow="hidden">
                          <text fg={palette.muted}>—</text>
                        </box>
                      )}
                      <box flexGrow={1} overflow="hidden">
                        <text fg={isFail ? palette.error : palette.muted} wrapMode="none">
                          {note}
                        </text>
                      </box>
                    </box>
                  );
                })}
              </box>
            );
          })}
        </box>
      </scrollbox>

      {/* 5. Helpful Status and Dismiss Banner */}
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
    </OverlayShell>
  );
}
