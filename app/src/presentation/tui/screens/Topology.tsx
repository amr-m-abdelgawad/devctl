import { useMemo, useState } from "react";
import { type DevctlConfig } from "../../../domain/config/types.ts";
import { displayState, emptyRuntime, type Runtime } from "../../../domain/service/services.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { EmptyState } from "../chrome.tsx";
import { NARROW_WIDTH } from "../helpers/chrome.ts";
import { clipText } from "../helpers/format.ts";
import { buildTopology, downstreamOf, upstreamOf, type TopologyLink } from "../helpers/topology.ts";
import { Chip, KeyHints, MetaBar, ScreenFrame, Toolbar, scrollboxStyle } from "../layout.tsx";
import { serviceColor, stateColor, stateGlyph, type Palette } from "../themes.ts";

const INSPECTOR_WIDTH = 30;
const NODE_MAX = 18;
const COLUMN_MIN = 16;

function healthTone(state: string): "success" | "warning" | "error" | "idle" {
  const s = state.toUpperCase();
  if (s === "HEALTHY") {
    return "success";
  }
  if (s === "UNHEALTHY") {
    return "warning";
  }
  if (s === "FAILED") {
    return "error";
  }
  return "idle";
}

function NodeCard(props: {
  palette: Palette;
  name: string;
  rt: Runtime;
  active: boolean;
  upstream: number;
  downstream: number;
  onSelect: () => void;
}) {
  const { palette, name, rt, active, upstream, downstream, onSelect } = props;
  const state = displayState(rt);
  const glyph = stateGlyph(state);
  const nodeColor = serviceColor(name, palette);
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      overflow="hidden"
      backgroundColor={active ? palette.element : undefined}
      onMouseDown={onSelect}
    >
      <text fg={stateColor(palette, state)} wrapMode="none">{`${glyph} `}</text>
      <box flexGrow={1} minWidth={0} overflow="hidden">
        <text fg={nodeColor} wrapMode="none">{clipText(name, NODE_MAX)}</text>
      </box>
      {upstream > 0 ? <text fg={palette.muted} wrapMode="none">{` ←${upstream}`}</text> : null}
      {downstream > 0 ? <text fg={palette.muted} wrapMode="none">{` →${downstream}`}</text> : null}
    </box>
  );
}

function LinkList(props: { palette: Palette; title: string; links: TopologyLink[] }) {
  const { palette, title, links } = props;
  return (
    <box flexDirection="column" flexShrink={0} overflow="hidden" marginTop={1}>
      <text fg={palette.muted} wrapMode="none">{title}</text>
      {links.length === 0 ? (
        <text fg={palette.muted} wrapMode="none">{"  —"}</text>
      ) : (
        links.map((link) => (
          <box key={`${title}-${link.name}`} flexDirection="row" flexShrink={0} overflow="hidden">
            <text fg={serviceColor(link.name, palette)} wrapMode="none">{`  ${clipText(link.name, NODE_MAX)}`}</text>
            {link.condition === "service_healthy" ? (
              <text fg={palette.muted} wrapMode="none">{" (healthy)"}</text>
            ) : null}
          </box>
        ))
      )}
    </box>
  );
}

function Inspector(props: { palette: Palette; name: string; rt: Runtime; up: TopologyLink[]; down: TopologyLink[] }) {
  const { palette, name, rt, up, down } = props;
  const state = displayState(rt);
  const ports = Object.values(rt.ports);
  return (
    <box flexDirection="column" flexShrink={0} overflow="hidden">
      <text fg={serviceColor(name, palette)} wrapMode="none">{clipText(name, INSPECTOR_WIDTH - 2)}</text>
      <box flexDirection="row" flexShrink={0} overflow="hidden" marginTop={1}>
        <Chip palette={palette} label={state} tone={healthTone(state)} />
        {rt.restarts > 0 ? <Chip palette={palette} label={`${rt.restarts}↻`} tone="warning" /> : null}
      </box>
      {rt.pid > 0 ? <text fg={palette.muted} wrapMode="none">{`pid ${rt.pid}`}</text> : null}
      {ports.length > 0 ? <text fg={palette.muted} wrapMode="none">{`ports ${ports.join(", ")}`}</text> : null}
      {rt.last_error ? <text fg={palette.error} wrapMode="word">{clipText(rt.last_error, (INSPECTOR_WIDTH - 2) * 3)}</text> : null}
      <LinkList palette={palette} title="depends on" links={up} />
      <LinkList palette={palette} title="required by" links={down} />
    </box>
  );
}

export function TopologyScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  width: number;
  profile: string;
}) {
  const { palette, cfg, snap, width, profile } = props;
  const model = useMemo(() => (cfg ? buildTopology(cfg, profile) : { columns: [], edges: [], cyclic: false }), [cfg, profile]);
  const allNodes = useMemo(() => model.columns.flat(), [model]);
  const [selected, setSelected] = useState("");
  const active = selected !== "" && allNodes.includes(selected) ? selected : (allNodes[0] ?? "");

  if (!cfg || allNodes.length === 0) {
    return (
      <ScreenFrame palette={palette} title="topology">
        <EmptyState palette={palette} title="No services" body="Add services under .devctl/config.yaml to see the dependency graph." />
      </ScreenFrame>
    );
  }

  const runtimeOf = (name: string): Runtime => snap?.services[name] ?? emptyRuntime(name);
  const fleet = allNodes.reduce(
    (acc, name) => {
      const s = displayState(runtimeOf(name)).toUpperCase();
      if (s === "HEALTHY") {
        acc.healthy += 1;
      } else if (s === "UNHEALTHY") {
        acc.unhealthy += 1;
      } else if (s === "FAILED") {
        acc.failed += 1;
      }
      return acc;
    },
    { healthy: 0, unhealthy: 0, failed: 0 },
  );

  const stacked = width < NARROW_WIDTH;
  const activeRt = runtimeOf(active);
  const up = upstreamOf(model.edges, active);
  const down = downstreamOf(model.edges, active);

  return (
    <ScreenFrame palette={palette} title="topology">
      <MetaBar
        palette={palette}
        items={[
          { text: `${allNodes.length} services`, tone: "primary" },
          { text: `${model.columns.length} waves`, tone: "idle" },
          ...(fleet.healthy > 0 ? [{ text: `${fleet.healthy} healthy`, tone: "success" as const }] : []),
          ...(fleet.unhealthy > 0 ? [{ text: `${fleet.unhealthy} unhealthy`, tone: "warning" as const }] : []),
          ...(fleet.failed > 0 ? [{ text: `${fleet.failed} failed`, tone: "error" as const }] : []),
          ...(model.cyclic ? [{ text: "dependency cycle", tone: "error" as const }] : []),
        ]}
      />
      <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden">
        <box flexGrow={1} flexBasis={0} minWidth={0} overflow="hidden" flexDirection="column">
          <scrollbox focused={false} stickyScroll={false} scrollX style={scrollboxStyle(palette)}>
            <box flexDirection="row" overflow="hidden" gap={2}>
              {model.columns.map((wave, waveIndex) => (
                <box
                  key={`wave-${waveIndex}`}
                  flexDirection="column"
                  flexShrink={0}
                  minWidth={COLUMN_MIN}
                  overflow="hidden"
                  border
                  borderStyle="rounded"
                  borderColor={palette.border}
                  title={`wave ${waveIndex + 1}`}
                  titleColor={palette.muted}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  {wave.map((name) => (
                    <NodeCard
                      key={name}
                      palette={palette}
                      name={name}
                      rt={runtimeOf(name)}
                      active={name === active}
                      upstream={upstreamOf(model.edges, name).length}
                      downstream={downstreamOf(model.edges, name).length}
                      onSelect={() => setSelected(name)}
                    />
                  ))}
                </box>
              ))}
            </box>
          </scrollbox>
        </box>
        <box
          flexShrink={0}
          width={stacked ? undefined : INSPECTOR_WIDTH}
          minHeight={stacked ? 8 : undefined}
          border
          borderStyle="rounded"
          borderColor={palette.borderActive}
          title="node"
          titleColor={palette.primary}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          overflow="hidden"
        >
          <Inspector palette={palette} name={active} rt={activeRt} up={up} down={down} />
        </box>
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints palette={palette} hints={[{ key: "click", label: "inspect a node" }]} />
      </Toolbar>
    </ScreenFrame>
  );
}
