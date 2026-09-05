import { useRef } from "react";
import {
  firstPort,
  padClip,
  SERVICE_COL_GAP,
  SERVICE_HEALTH_COL,
  SERVICE_PID_COL,
  SERVICE_PORT_COL,
  SERVICE_STATE_COL,
  serviceLineState,
  serviceNameColumnWidth,
  serviceRowShowsHealth,
  serviceRowShowsPid,
  serviceRowShowsPort,
} from "../helpers.ts";
import { useDensity } from "../density.tsx";
import { MetaBar } from "../layout.tsx";
import { serviceColor, stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type StatusSnapshot } from "../../../types.ts";

export function ServiceRows(props: {
  palette: Palette;
  names: string[];
  snap?: StatusSnapshot;
  selected: number;
  checked: string[];
  width: number;
  onOpen: (name: string) => void;
  onSelectIndex: (index: number) => void;
  onToggle?: (name: string) => void;
}) {
  const { palette, names, snap, selected, checked, width, onOpen, onSelectIndex, onToggle } = props;
  const scale = useDensity();
  const skipRowClick = useRef(false);
  const selectedNames = new Set(checked);
  const showPid = serviceRowShowsPid(width);
  const showPort = serviceRowShowsPort(width);
  const showHealth = serviceRowShowsHealth(width);
  const nameWidth = serviceNameColumnWidth(width);
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <box height={1} flexDirection="row" overflow="hidden">
        <Col width={2} fg={palette.muted} text="" />
        <Col width={4} fg={palette.accent} text="sel" />
        <Col width={2} fg={palette.muted} text="" />
        <Col width={nameWidth} fg={palette.muted} text="name" />
        <Col width={SERVICE_COL_GAP} fg={palette.muted} text="" />
        <Col width={SERVICE_STATE_COL} fg={palette.muted} text="state" />
        {showHealth ? <Col width={SERVICE_HEALTH_COL} fg={palette.muted} text="health" /> : null}
        {showPort ? <Col width={SERVICE_PORT_COL} fg={palette.muted} text="port" /> : null}
        {showPid ? <Col width={SERVICE_PID_COL} fg={palette.muted} text="pid" /> : null}
      </box>
      {names.map((name, i) => {
        const rt = snap?.services[name];
        const state = serviceLineState(rt);
        const health = rt?.health ?? "UNKNOWN";
        const marked = selectedNames.has(name);
        const focused = i === selected;
        const mark = marked ? "[x]" : "[ ]";
        const cursor = focused ? "›" : " ";
        return (
          <box
            key={name}
            height={scale.rowH}
            flexDirection="row"
            overflow="hidden"
            backgroundColor={focused ? palette.highlight : marked ? palette.element : undefined}
            onMouseDown={() => {
              if (skipRowClick.current) {
                return;
              }
              if (focused) {
                onOpen(name);
                return;
              }
              onSelectIndex(i);
            }}
          >
            <box width={2} flexShrink={0}>
              <text fg={palette.primary}>{cursor}</text>
            </box>
            <box
              width={4}
              flexShrink={0}
              onMouseDown={() => {
                skipRowClick.current = true;
                onToggle?.(name);
                setTimeout(() => {
                  skipRowClick.current = false;
                }, 0);
              }}
            >
              <text fg={markColor(palette, marked, focused)}>{mark}</text>
            </box>
            <box width={2} flexShrink={0}>
              <text fg={stateColor(palette, state)}>{stateGlyph(state)}</text>
            </box>
            <Col width={nameWidth} fg={focused ? palette.primary : serviceColor(name, palette)} text={padClip(name, nameWidth)} />
            <Col width={SERVICE_COL_GAP} fg={palette.muted} text="" />
            <Col width={SERVICE_STATE_COL} fg={stateColor(palette, state)} text={state} />
            {showHealth ? <Col width={SERVICE_HEALTH_COL} fg={stateColor(palette, health)} text={health} /> : null}
            {showPort ? <Col width={SERVICE_PORT_COL} fg={palette.text} text={firstPort(rt)} /> : null}
            {showPid ? <Col width={SERVICE_PID_COL} fg={palette.text} text={rt?.pid ? String(rt.pid) : ""} /> : null}
          </box>
        );
      })}
    </box>
  );
}

export function SelectionHint(props: {
  palette: Palette;
  checked: string[];
  idle: boolean;
  profileName: string;
  members: string;
}) {
  const { palette, checked, idle, profileName } = props;
  const count = checked.length;
  if (count > 0) {
    return (
      <MetaBar
        palette={palette}
        items={[{ text: `${count} selected`, tone: "primary" }]}
        hints={[
          { key: "space", label: "unmark" },
          { key: "*", label: "all" },
          { key: "-", label: "none" },
          { key: "n", label: "start these" },
          { key: "x", label: "stop these" },
        ]}
      />
    );
  }
  if (idle) {
    return (
      <MetaBar
        palette={palette}
        items={[{ text: "none started", tone: "idle" }]}
        hints={[
          { key: "space", label: "select" },
          { key: "enter", label: profileName ? `start ${profileName}` : "open" },
          { key: "n", label: "start" },
        ]}
      />
    );
  }
  return (
    <MetaBar
      palette={palette}
      items={[{ text: "running", tone: "success" }]}
      hints={[
        { key: "space", label: "select" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
      ]}
    />
  );
}

function markColor(palette: Palette, marked: boolean, focused: boolean): string {
  if (marked) {
    return palette.success;
  }
  if (focused) {
    return palette.primary;
  }
  return palette.muted;
}

function Col(props: { width: number; fg: string; text: string }) {
  return (
    <box width={props.width} flexShrink={0} overflow="hidden">
      <text fg={props.fg} wrapMode="none">
        {props.text}
      </text>
    </box>
  );
}
