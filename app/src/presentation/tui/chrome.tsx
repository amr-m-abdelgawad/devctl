import { type DevctlConfig } from "../../domain/config/types.ts";
import { type GoogleStatus } from "../../domain/identity/google-status.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { versionLine } from "../../version.ts";
import { useDensity } from "./density.tsx";
import { HEADER_STACK_WIDTH,headerStatusChips,statusChipTone,visibleHints } from "./helpers/chrome.ts";
import { COMMAND_FOOTER_HINT, footerHints } from "./helpers/command-catalog.ts";
import { clipText } from "./helpers/format.ts";
import { NAV_ITEMS,navActiveIndex,navTabLabel } from "./helpers/navigation.ts";
import { countRunning } from "./helpers/stats.ts";
import { Banner,Chip,KeyHints,MetaBar,TabStrip,Toolbar,type ChipTone } from "./layout.tsx";
import { isTightScale } from "./settings.ts";
import { type Palette } from "./themes.ts";
import { type Overlay,type Screen } from "./types.ts";

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
  const chips = headerStatusChips({
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
    .map((chip) => <Chip key={chip.label} palette={palette} label={chip.label} tone={chip.tone} />);
  const tight = isTightScale(useDensity());
  const identity = (
    <box height={1} flexGrow={1} overflow="hidden" backgroundColor={palette.panel} paddingLeft={1}>
      <text wrapMode="none">
        <span fg={palette.primary}>{versionLine()}</span>
        <span fg={palette.muted}>{`  ${project}`}</span>
        <span fg={palette.accent}>{`  ${profileName}`}</span>
      </text>
    </box>
  );
  return (
    <Toolbar palette={palette} backgroundColor={palette.panel} ruled={!tight}>
    <box height={stacked ? 2 : 1} flexDirection="column" backgroundColor={palette.panel} overflow="hidden">
      <box height={1} flexDirection="row" overflow="hidden">
        {identity}
        {stacked ? null : chips}
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

const NAV_SLASH_HINT_WIDTH = COMMAND_FOOTER_HINT.key.length + COMMAND_FOOTER_HINT.label.length + 3;
const NAV_SLASH_MIN_TABS = 8;

export function NavStrip(props: {
  palette: Palette;
  screen: Screen;
  width: number;
  onSelect: (screen: Screen) => void;
}) {
  const { palette, screen, width, onSelect } = props;
  const showSlash = width >= NAV_SLASH_HINT_WIDTH + NAV_SLASH_MIN_TABS;
  const tabWidth = showSlash ? Math.max(1, width - NAV_SLASH_HINT_WIDTH) : width;
  const items = NAV_ITEMS.map((item) => ({ id: item.id, label: navTabLabel(item.label, tabWidth) }));
  const active = navActiveIndex(screen);
  return (
    <Toolbar palette={palette} backgroundColor={palette.element}>
    <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      <TabStrip
        palette={palette}
        items={items}
        active={active}
        width={tabWidth}
        onPick={(index) => {
          const item = NAV_ITEMS[index];
          if (item) {
            onSelect(item.id);
          }
        }}
      />
      {showSlash ? (
        <>
          <box flexGrow={1} backgroundColor={palette.element} />
          <KeyHints palette={palette} hints={[COMMAND_FOOTER_HINT]} />
        </>
      ) : null}
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
          { text: screen, tone: "ghost" },
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
