import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import {
  firstPort,
  padClip,
  planActionCopy,
  planProgress,
  planRowNote,
  planTitle,
  serviceLineState,
  waveCardTitle,
  waveStatus,
  type WaveStatus,
} from "../helpers.ts";
import { Chip, OverlayShell, scrollboxStyle, type ChipTone } from "../layout.tsx";
import { serviceColor, stateColor, type Palette } from "../themes.ts";
import { type LifecycleKind } from "../types.ts";
import { type Plan } from "../../services.ts";
import { type StatusSnapshot } from "../../types.ts";

type WavePresentation = {
  icon: string;
  label: string;
  tone: ChipTone;
  color: string;
};

function wavePresentation(status: WaveStatus, palette: Palette): WavePresentation {
  switch (status) {
    case "completed":
      return { icon: "✓", label: "Completed", tone: "success", color: palette.success };
    case "failed":
      return { icon: "✗", label: "Failed", tone: "error", color: palette.error };
    case "unhealthy":
      return { icon: "⚠", label: "Unhealthy", tone: "warning", color: palette.warning };
    case "active":
      return { icon: "●", label: "In progress", tone: "primary", color: palette.primary };
    default:
      return { icon: "○", label: "Queued", tone: "muted", color: palette.muted };
  }
}

function operationPresentation(busy: boolean, failed: string, current: WaveStatus, palette: Palette): WavePresentation {
  if (failed !== "") {
    return { icon: "✗", label: "Failed", tone: "error", color: palette.error };
  }
  if (!busy) {
    return { icon: "✓", label: "Finished", tone: "success", color: palette.success };
  }
  if (current === "unhealthy") {
    return { icon: "⚠", label: "Waiting on health", tone: "warning", color: palette.warning };
  }
  return { icon: "●", label: "Running", tone: "primary", color: palette.primary };
}

function SectionLabel(props: { palette: Palette; label: string; detail?: string }) {
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
      <text wrapMode="none">
        <span fg={props.palette.primary}>{props.label.toUpperCase()}</span>
        {props.detail ? <span fg={props.palette.muted}>{`  ${props.detail}`}</span> : null}
      </text>
    </box>
  );
}

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
  initiallyRunning?: string[];
  onDismiss: () => void;
}) {
  const { palette, plan, snap, busy, failed, kind, termW = 80, termH = 24, scrollRef, initiallyRunning = [], onDismiss } = props;
  const initiallyRunningSet = new Set(initiallyRunning);
  // Only omit services that were already running when this operation began.
  // Newly-started services stay in their original wave card while their live
  // state advances through STARTING/RUNNING/UNHEALTHY/HEALTHY.
  const waves = plan.waves
    .map((wave, waveIdx) => ({ wave: wave.filter((name) => !initiallyRunningSet.has(name)), waveIdx }))
    .filter(({ wave }) => wave.length > 0);
  const progress = planProgress(plan, snap, kind);
  const currentWave = plan.waves[progress.currentWaveIndex] ?? [];
  const currentStatus = waveStatus(currentWave, snap, kind);
  const current = wavePresentation(currentStatus, palette);
  const operation = operationPresentation(busy, failed, currentStatus, palette);
  const title = planTitle(kind, busy, failed, plan.profile);
  const action = planActionCopy(busy, failed);
  const actionFg = failed ? palette.inverse : palette.text;
  const actionBg = failed ? palette.error : palette.element;
  const contentWidth = Math.min(92, Math.max(40, termW - 8));
  const serviceWidth = contentWidth >= 82 ? 22 : contentWidth >= 66 ? 17 : 13;
  const stateWidth = 12;
  const portWidth = 9;
  const showPort = contentWidth >= 56;
  const showDetail = contentWidth >= 72;
  const compactPipeline = contentWidth < 72 || plan.waves.length > 3;
  const profileLabel = plan.profile ? `PROFILE ${plan.profile}` : kind.toUpperCase();

  return (
    <OverlayShell
      palette={palette}
      title={title}
      bottomTitle="enter close  ·  esc hide (operation continues)"
      termW={termW}
      termH={termH}
      preferW={98}
      preferH={28}
      borderColor={operation.color}
      gap={0}
    >
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element}>
        <Chip palette={palette} label={`${operation.icon} ${operation.label.toUpperCase()}`} tone={operation.tone} />
        <box paddingLeft={1} flexGrow={1} overflow="hidden">
          <text fg={palette.text} wrapMode="none">{profileLabel}</text>
        </box>
        <Chip palette={palette} label={`${progress.ready}/${progress.total} READY`} tone={progress.isComplete ? "success" : "info"} />
        <Chip
          palette={palette}
          label={`WAVE ${Math.min(progress.currentWaveIndex + 1, Math.max(1, progress.totalWaves))}/${Math.max(1, progress.totalWaves)}`}
          tone={current.tone}
        />
      </box>

      <box height={2} flexDirection="column" overflow="hidden" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <box height={1} flexDirection="row" overflow="hidden">
          <text wrapMode="none">
            <span fg={palette.muted}>PROGRESS </span>
            <span fg={operation.color}>{`[${progress.progressBar}]`}</span>
            <span fg={palette.text}>{` ${progress.percent}%`}</span>
          </text>
          <box flexGrow={1} />
          <text wrapMode="none">
            <span fg={current.color}>{`${current.icon} ${current.label}`}</span>
          </text>
        </box>
        <box height={1} overflow="hidden">
          <text fg={palette.muted} wrapMode="none">
            {busy
              ? kind === "stop"
                ? "Dependents stop first; each wave waits for the previous wave."
                : "Each wave waits until its services are healthy before the next wave starts."
              : action.primary}
          </text>
        </box>
      </box>

      <SectionLabel palette={palette} label="Pipeline" detail={`${plan.waves.length} execution wave${plan.waves.length === 1 ? "" : "s"}`} />
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element}>
        {plan.waves.map((wave, idx) => {
          const status = waveStatus(wave, snap, kind);
          const presentation = wavePresentation(status, palette);
          const label = compactPipeline
            ? `W${idx + 1} ${presentation.icon} ${wave.length}`
            : `W${idx + 1}  ${presentation.icon} ${presentation.label}  · ${wave.length}`;
          return (
            <box key={`step-${idx}`} flexDirection="row" overflow="hidden" flexShrink={0}>
              <Chip palette={palette} label={label} tone={presentation.tone} />
              {idx < plan.waves.length - 1 ? (
                <box width={3} flexShrink={0} overflow="hidden">
                  <text fg={palette.muted}> ─►</text>
                </box>
              ) : null}
            </box>
          );
        })}
      </box>

      {(plan.blockers ?? []).length > 0 ? (
        <box minHeight={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element} paddingLeft={1}>
          <text fg={palette.error} wrapMode="word">
            {`BLOCKED  ${plan.blockers?.map((blocker) => `${blocker.name}: ${blocker.message}`).join("  ·  ")}`}
          </text>
        </box>
      ) : null}

      {initiallyRunning.length > 0 ? (
        <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} paddingLeft={1}>
          <text wrapMode="none">
            <span fg={palette.success}>✓ ALREADY READY</span>
            <span fg={palette.muted}>{`  ${initiallyRunning.join(", ")}`}</span>
          </text>
        </box>
      ) : null}

      <SectionLabel palette={palette} label="Wave details" detail="live process and health state" />
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element} paddingLeft={1}>
        <box width={2} flexShrink={0} />
        <box width={serviceWidth} flexShrink={0} overflow="hidden">
          <text fg={palette.muted}>{padClip("SERVICE", serviceWidth)}</text>
        </box>
        <box width={stateWidth} flexShrink={0} overflow="hidden">
          <text fg={palette.muted}>{padClip("STATE", stateWidth)}</text>
        </box>
        {showPort ? (
          <box width={portWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.muted}>{padClip("PORT", portWidth)}</text>
          </box>
        ) : null}
        {showDetail ? (
          <box flexGrow={1} overflow="hidden">
            <text fg={palette.muted}>DETAIL</text>
          </box>
        ) : null}
      </box>

      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden" gap={1}>
          {waves.map(({ wave, waveIdx }) => {
            const status = waveStatus(wave, snap, kind);
            const presentation = wavePresentation(status, palette);
            const waveHeading = `${waveCardTitle(kind, waveIdx, status)} · ${wave.length} service${wave.length === 1 ? "" : "s"}`;
            return (
              <box
                key={`wave-card-${waveIdx}`}
                border
                borderStyle="rounded"
                borderColor={presentation.color}
                title={waveHeading}
                titleColor={presentation.color}
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
                  const isUnhealthy = state === "UNHEALTHY";
                  const isReady = state === "HEALTHY" || (kind === "stop" && state === "STOPPED");
                  const port = firstPort(rt);
                  const glyph = isFail
                    ? "✗"
                    : isReady
                      ? "✓"
                      : isUnhealthy
                        ? "⚠"
                        : state === "STARTING" || state === "RUNNING" || state === "STOPPING" || state === "RESTARTING"
                          ? "●"
                          : "○";
                  const glyphColor = isFail ? palette.error : stateColor(palette, state);
                  const noteColor = isFail ? palette.error : isUnhealthy ? palette.warning : isReady ? palette.success : palette.muted;
                  return (
                    <box key={name} height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
                      <box width={2} flexShrink={0} overflow="hidden">
                        <text fg={glyphColor}>{glyph}</text>
                      </box>
                      <box width={serviceWidth} flexShrink={0} overflow="hidden">
                        <text fg={serviceColor(name, palette)} wrapMode="none">
                          {padClip(name, serviceWidth)}
                        </text>
                      </box>
                      <box width={stateWidth} flexShrink={0} overflow="hidden">
                        <text fg={stateColor(palette, state)} wrapMode="none">
                          {padClip(state, stateWidth)}
                        </text>
                      </box>
                      {showPort ? (
                        <box width={portWidth} flexShrink={0} overflow="hidden">
                          <text fg={port ? palette.info : palette.muted} wrapMode="none">
                            {padClip(port ? `:${port}` : "—", portWidth)}
                          </text>
                        </box>
                      ) : null}
                      {showDetail ? (
                        <box flexGrow={1} overflow="hidden">
                          <text fg={noteColor} wrapMode="none">
                            {note}
                          </text>
                        </box>
                      ) : null}
                    </box>
                  );
                })}
              </box>
            );
          })}
        </box>
      </scrollbox>

      <box
        height={3}
        flexShrink={0}
        flexDirection="column"
        backgroundColor={actionBg}
        border={["top"]}
        borderStyle="single"
        borderColor={operation.color}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
        onMouseDown={onDismiss}
      >
        <text fg={actionFg} wrapMode="none">
          {action.primary}
        </text>
        <text fg={failed ? palette.inverse : palette.muted} wrapMode="none">
          {action.secondary}
        </text>
      </box>
    </OverlayShell>
  );
}
