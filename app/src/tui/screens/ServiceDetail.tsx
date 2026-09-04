import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import {
  clipText,
  envKeyColumnWidth,
  firstPort,
  padClip,
  serviceCommandText,
  serviceEnvEntries,
  serviceHealthText,
  serviceIdentityText,
  serviceLineState,
  servicePortsText,
  serviceRestartText,
  type ServiceEnvEntry,
} from "../helpers.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { KeyHints, MetaBar, type ChipTone } from "../layout.tsx";
import { serviceColor, type Palette } from "../themes.ts";
import { dependencyLabel, type DevctlConfig } from "../../config/index.ts";
import { type StatusSnapshot } from "../../types.ts";

const ERROR_PREVIEW = 72;
const TWO_COL_MIN = 56;
const FACT_LABEL = 9;

export function ServiceDetail(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  name: string;
  reveal: boolean;
  width: number;
  envScrollRef?: Ref<ScrollBoxRenderable>;
  resolvedEnv?: Record<string, string>;
  envStatus?: "resolved" | "config" | "loading" | "error";
  envError?: string;
}) {
  const { palette, name } = props;
  return (
    <box
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={palette.borderActive}
      backgroundColor={palette.panel}
      title={name}
      titleColor={serviceColor(name, palette)}
      flexDirection="column"
      overflow="hidden"
    >
      <ServiceInspector {...props} compact={false} />
    </box>
  );
}

export function ServiceInspector(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  name: string;
  reveal: boolean;
  width: number;
  compact?: boolean;
  envScrollRef?: Ref<ScrollBoxRenderable>;
  resolvedEnv?: Record<string, string>;
  envStatus?: "resolved" | "config" | "loading" | "error";
  envError?: string;
}) {
  const { palette, cfg, snap, name, reveal, width, compact = true, envScrollRef } = props;
  const scale = useDensity();
  const svc = cfg?.services[name];
  if (!svc) {
    return <EmptyState palette={palette} title="Unknown service" body={`No service named ${name}.`} hint="j/k  move" />;
  }
  const rt = snap?.services[name];
  const state = serviceLineState(rt);
  const health = rt?.health ?? "UNKNOWN";
  const port = firstPort(rt) || servicePortsText(svc, rt);
  const entries = serviceEnvEntries(svc, reveal, cfg?.secrets.extra_markers ?? [], cfg?.secrets.extra_patterns ?? [], props.resolvedEnv);
  const envTone = props.envStatus === "error" ? "error" : props.envStatus === "resolved" ? "success" : props.envStatus === "loading" ? "info" : "muted";
  const envLabel =
    props.envStatus === "resolved"
      ? "resolved"
      : props.envStatus === "loading"
        ? "resolving"
        : props.envStatus === "error"
          ? "config fallback"
          : "config";
  const wide = width >= TWO_COL_MIN;
  const leftFacts: FactItem[] = [
    { label: "health", value: serviceHealthText(svc) },
    { label: "workdir", value: svc.working_dir || "." },
    { label: "restart", value: serviceRestartText(svc) },
    { label: "caps", value: svc.capabilities.join(", ") || "—" },
    { label: "runtime", value: svc.container ? `${svc.container.runtime || "docker"} · ${svc.container.image}` : "host" },
  ];
  const rightFacts: FactItem[] = [
    { label: "identity", value: serviceIdentityText(svc, rt) },
    { label: "depends", value: svc.dependencies.map(dependencyLabel).join(", ") || "—" },
    { label: "ports", value: servicePortsText(svc, rt) },
    { label: "tries", value: String(rt?.restarts ?? 0), tone: rt?.restarts ? "warning" : "muted" },
  ];
  const innerWidth = Math.max(FACT_LABEL + 8, width - 2);
  const colWidth = wide ? Math.floor(innerWidth / 2) : innerWidth;
  return (
    <box padding={scale.pad} flexGrow={1} flexDirection="column" overflow="hidden">
      <MetaBar
        palette={palette}
        items={[
          { text: state, tone: runtimeChipTone(state) },
          { text: health, tone: runtimeChipTone(health) },
          { text: rt?.pid ? `pid ${rt.pid}` : "pid —", tone: rt?.pid ? "info" : "idle" },
          { text: port === "—" ? "port —" : `port ${port}`, tone: port === "—" ? "idle" : "info" },
        ]}
      />
      {svc.description ? (
        <box height={1} overflow="hidden">
          <text fg={palette.muted} wrapMode="none">
            {clipText(svc.description, Math.max(8, width - 4))}
          </text>
        </box>
      ) : null}
      {rt?.last_error ? (
        <box height={1} overflow="hidden">
          <text fg={palette.error} wrapMode="none">
            {clipText(rt.last_error, ERROR_PREVIEW)}
          </text>
        </box>
      ) : null}
      <Fact
        palette={palette}
        item={{ label: "command", value: serviceCommandText(svc) }}
        valueWidth={Math.max(8, innerWidth - FACT_LABEL)}
      />
      <FactGrid palette={palette} left={leftFacts} right={rightFacts} wide={wide} colWidth={colWidth} />
      <EnvPane
        palette={palette}
        entries={entries}
        reveal={reveal}
        width={width}
        focused={!compact}
        scrollRef={envScrollRef}
        source={envLabel}
        sourceTone={envTone}
        error={props.envError}
      />
      {compact ? null : (
        <KeyHints
          palette={palette}
          hints={[
            { key: "n", label: "start" },
            { key: "x", label: "stop" },
              { key: "R", label: "restart" },
              { key: "o", label: "config" },
            { key: "l", label: "logs" },
            { key: "/reveal", label: "secrets" },
            { key: "esc", label: "back" },
          ]}
        />
      )}
    </box>
  );
}

type FactTone = "text" | "warning" | "muted";

type FactItem = {
  label: string;
  value: string;
  tone?: FactTone;
};

function FactGrid(props: { palette: Palette; left: FactItem[]; right: FactItem[]; wide: boolean; colWidth: number }) {
  const { palette, left, right, wide, colWidth } = props;
  const valueWidth = Math.max(4, colWidth - FACT_LABEL);
  if (!wide) {
    return (
      <box width={colWidth} flexShrink={0} flexDirection="column" overflow="hidden">
        {[...left, ...right].map((item) => (
          <Fact key={item.label} palette={palette} item={item} valueWidth={valueWidth} />
        ))}
      </box>
    );
  }
  return (
    <box height={left.length} flexShrink={0} flexDirection="row" overflow="hidden">
      <FactColumn palette={palette} items={left} width={colWidth} />
      <FactColumn palette={palette} items={right} width={colWidth} />
    </box>
  );
}

function FactColumn(props: { palette: Palette; items: FactItem[]; width: number }) {
  const valueWidth = Math.max(4, props.width - FACT_LABEL);
  return (
    <box width={props.width} flexShrink={0} flexDirection="column" overflow="hidden">
      {props.items.map((item) => (
        <Fact key={item.label} palette={props.palette} item={item} valueWidth={valueWidth} />
      ))}
    </box>
  );
}

function Fact(props: { palette: Palette; item: FactItem; valueWidth: number }) {
  const { palette, item, valueWidth } = props;
  const fg = item.tone === "warning" ? palette.warning : item.tone === "muted" ? palette.muted : palette.text;
  return (
    <box height={1} width={FACT_LABEL + valueWidth} flexDirection="row" overflow="hidden">
      <box width={FACT_LABEL} flexShrink={0} overflow="hidden">
        <text fg={palette.muted} wrapMode="none">
          {padClip(item.label, FACT_LABEL)}
        </text>
      </box>
      <box width={valueWidth} flexShrink={0} overflow="hidden">
        <text fg={fg} wrapMode="none">
          {padClip(item.value, valueWidth)}
        </text>
      </box>
    </box>
  );
}

function EnvPane(props: {
  palette: Palette;
  entries: ServiceEnvEntry[];
  reveal: boolean;
  width: number;
  focused: boolean;
  scrollRef?: Ref<ScrollBoxRenderable>;
  source: string;
  sourceTone: ChipTone;
  error?: string;
}) {
  const { palette, entries, reveal, width, focused, scrollRef, source, sourceTone, error } = props;
  const keyWidth = envKeyColumnWidth(width);
  const valueWidth = Math.max(8, width - keyWidth - 4);
  return (
    <box flexGrow={1} flexDirection="column" overflow="hidden">
      <MetaBar
        palette={palette}
        items={[
          { text: `env ${entries.length}`, tone: entries.length > 0 ? "info" : "idle" },
          { text: source, tone: sourceTone },
          { text: reveal ? "secrets shown" : "redacted", tone: reveal ? "warning" : "muted" },
        ]}
        hints={focused ? [{ key: "j/k", label: "scroll" }] : [{ key: "/reveal", label: "secrets" }]}
      />
      {error ? (
        <box height={1} overflow="hidden">
          <text fg={palette.warning} wrapMode="none">
            {clipText(error, Math.max(8, width - 4))}
          </text>
        </box>
      ) : null}
      {entries.length === 0 ? (
        <text fg={palette.muted}>no service env overrides</text>
      ) : (
        <box flexGrow={1} height="100%" overflow="hidden">
          <scrollbox
            ref={scrollRef}
            focused={focused}
            stickyScroll={false}
            scrollX={false}
            style={{
              rootOptions: { flexGrow: 1, height: "100%", overflow: "hidden", backgroundColor: palette.panel },
              viewportOptions: { backgroundColor: palette.panel },
              contentOptions: { backgroundColor: palette.panel },
              scrollbarOptions: {
                trackOptions: { foregroundColor: palette.primary, backgroundColor: palette.element },
              },
            }}
          >
            <box flexDirection="column" overflow="hidden">
              {entries.map((entry) => (
                <box key={entry.key} height={1} flexDirection="row" overflow="hidden">
                  <box width={keyWidth} flexShrink={0} overflow="hidden">
                    <text fg={entry.required ? palette.warning : palette.muted} wrapMode="none">
                      {padClip(entry.required ? `${entry.key}*` : entry.key, keyWidth)}
                    </text>
                  </box>
                  <box width={valueWidth} flexShrink={0} overflow="hidden">
                    <text fg={entry.value === "" ? palette.muted : palette.text} wrapMode="none">
                      {padClip(entry.value === "" && entry.required ? "(required)" : entry.value, valueWidth)}
                    </text>
                  </box>
                </box>
              ))}
            </box>
          </scrollbox>
        </box>
      )}
    </box>
  );
}

function runtimeChipTone(state: string): ChipTone {
  switch (state.toUpperCase()) {
    case "HEALTHY":
    case "RUNNING":
      return "success";
    case "UNHEALTHY":
    case "WARNING":
    case "WARN":
    case "STARTING":
    case "RESTARTING":
      return "warning";
    case "FAILED":
    case "ERROR":
      return "error";
    default:
      return "muted";
  }
}
