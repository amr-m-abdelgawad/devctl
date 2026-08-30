import { versionLine } from "../version.ts";
import { useDensity } from "./density.tsx";
import { clipText, countRunning, footerHints, headerStatusChips, HEADER_STACK_WIDTH, NAV_ITEMS, navActiveIndex, navTabLabel, statusChipTone, visibleHints } from "./helpers.ts";
import { Banner, Chip, KeyHints, MetaBar, TabStrip, Toolbar, type ChipTone } from "./layout.tsx";
import { isTightScale } from "./settings.ts";
import { stateColor, stateGlyph, type Palette } from "./themes.ts";
import { type Overlay, type Screen } from "./types.ts";
import { type DevctlConfig } from "../config/index.ts";
import { type GoogleStatus } from "../google.ts";
import { type StatusSnapshot } from "../types.ts";

export function Header(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  google?: GoogleStatus;
  profile: string;
  reveal: boolean;
  width: number;
}) {
  const { palette, cfg, snap, google, profile, reveal, width } = props;
  const counts = countRunning(snap, cfg ? Object.keys(cfg.services) : undefined);
  const proxyOn = snap?.proxy.running === true;
  const adc = google?.adcAvailable === true;
  const stacked = width < HEADER_STACK_WIDTH;
  const project = clipText(cfg?.project.name || "local", stacked ? 18 : 22);
  const profileName = clipText(profile || snap?.profile || "no profile", 16);
  const chips = (
    <>
      {headerStatusChips({
        width,
        running: counts.running,
        total: counts.total,
        proxyOn,
        proxyAddress: snap?.proxy.address ?? "",
        mcpOn: snap?.mcp?.running === true,
        adc,
        reveal,
      })
        .filter((chip) => !chip.hide && chip.label !== "")
        .map((chip) => (
          <Chip key={chip.label} palette={palette} label={chip.label} tone={chip.tone} />
        ))}
    </>
  );
  const tight = isTightScale(useDensity());
  return (
    <Toolbar palette={palette} backgroundColor={palette.panel} ruled={!tight}>
    <box height={stacked ? 2 : 1} flexDirection="column" backgroundColor={palette.panel} overflow="hidden">
      <box height={1} flexDirection="row" overflow="hidden">
        <Chip palette={palette} label={versionLine()} tone="primary" />
        <Chip palette={palette} label={project} tone="idle" />
        <Chip palette={palette} label={profileName} tone="accent" />
        {stacked ? null : (
          <>
            <box flexGrow={1} backgroundColor={palette.panel} />
            {chips}
          </>
        )}
      </box>
      {stacked ? (
        <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.panel}>
          {chips}
        </box>
      ) : null}
    </box>
    </Toolbar>
  );
}

export function NavStrip(props: {
  palette: Palette;
  screen: Screen;
  width: number;
  onSelect: (screen: Screen) => void;
}) {
  const { palette, screen, width, onSelect } = props;
  const items = NAV_ITEMS.map((item) => ({ id: item.id, label: navTabLabel(item.label, width) }));
  const active = navActiveIndex(screen);
  return (
    <Toolbar palette={palette} backgroundColor={palette.element}>
    <TabStrip
      palette={palette}
      items={items}
      active={active}
      width={width}
      onPick={(index) => {
        const item = NAV_ITEMS[index];
        if (item) {
          onSelect(item.id);
        }
      }}
    />
    </Toolbar>
  );
}

export function CommandLine(props: {
  palette: Palette;
  overlay: Overlay;
  query: string;
  onQuery: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const { palette, overlay, query, onQuery, onSubmit } = props;
  const editing = overlay === "slash" || overlay === "palette";
  if (editing) {
    const prefix = overlay === "slash" ? "/" : "> ";
    return (
      <Toolbar palette={palette} backgroundColor={palette.highlight} edge="top">
      <box height={1} backgroundColor={palette.highlight} paddingLeft={1} flexDirection="row" overflow="hidden">
        <box width={2} flexShrink={0}>
          <text fg={palette.primary}>{prefix}</text>
        </box>
        <box flexGrow={1} overflow="hidden">
          <input
            focused
            value={query}
            placeholder={overlay === "slash" ? "start auth" : "filter commands"}
            onInput={onQuery}
            onSubmit={() => onSubmit(query)}
            backgroundColor={palette.highlight}
            focusedBackgroundColor={palette.highlight}
            textColor={palette.text}
            cursorColor={palette.primary}
          />
        </box>
      </box>
      </Toolbar>
    );
  }
  const hints =
    overlay === "leader"
      ? [
          { key: "n", label: "start" },
          { key: "x", label: "stop" },
          { key: "R", label: "restart" },
          { key: "s", label: "services" },
          { key: "l", label: "logs" },
          { key: "t", label: "themes" },
          { key: "q", label: "quit" },
        ]
      : [
          { key: "/", label: "command" },
          { key: "ctrl+p", label: "palette" },
          { key: "ctrl+x", label: "leader" },
          { key: "?", label: "help" },
        ];
  return (
    <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
    <box height={1} backgroundColor={palette.element} overflow="hidden">
      <KeyHints palette={palette} hints={hints} />
    </box>
    </Toolbar>
  );
}

export function StatusBar(props: {
  palette: Palette;
  screen: Screen;
  overlay: Overlay;
  status: string;
  paused: boolean;
  errorOnly: boolean;
  width: number;
  copyKey?: string;
}) {
  const { palette, screen, overlay, status, paused, errorOnly, width, copyKey } = props;
  const tight = isTightScale(useDensity());
  const hintBudget = Math.max(18, Math.floor(width * 0.42));
  const hints = visibleHints(footerHints(screen, overlay, copyKey), hintBudget);
  const statusTone: ChipTone = statusChipTone(status);
  return (
    <Toolbar palette={palette} backgroundColor={palette.panel} edge="top" ruled={!tight}>
    <box height={1} backgroundColor={palette.panel} overflow="hidden">
      <MetaBar
        ruled={false}
        palette={palette}
        items={[
          { text: screen, tone: "primary" },
          { text: paused ? "PAUSED" : "LIVE", tone: paused ? "warning" : "success" },
          ...(errorOnly ? [{ text: "ERROR+", tone: "error" as const }] : []),
          ...(status === "" ? [] : [{ text: clipText(status, Math.max(16, width - hintBudget - 28)), tone: statusTone }]),
        ]}
        hints={hints}
      />
    </box>
    </Toolbar>
  );
}

export function EmptyState(props: { palette: Palette; title: string; body: string; hint?: string }) {
  return (
    <box flexGrow={1} padding={1} overflow="hidden">
      <Banner palette={props.palette} title={props.title} body={props.body} hint={props.hint} />
    </box>
  );
}

export function LoadingState(props: { palette: Palette; label: string }) {
  return (
    <box flexGrow={1} padding={1} overflow="hidden">
      <text fg={props.palette.text}>{props.label}</text>
    </box>
  );
}

export function ErrorState(props: { palette: Palette; title: string; body: string }) {
  return (
    <box flexGrow={1} padding={1} flexDirection="column" overflow="hidden">
      <text fg={props.palette.error}>{props.title}</text>
      <text fg={props.palette.text} wrapMode="word">
        {props.body}
      </text>
    </box>
  );
}

export function StateLabel(props: { palette: Palette; state: string; extra?: string }) {
  const { palette, state, extra } = props;
  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <text fg={stateColor(palette, state)}>{`${stateGlyph(state)} ${state}`}</text>
      {extra ? (
        <text fg={palette.error} wrapMode="none">
          {`  ${extra}`}
        </text>
      ) : null}
    </box>
  );
}
