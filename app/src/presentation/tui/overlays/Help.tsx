import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { versionLine } from "../../../version.ts";
import { useDensity } from "../density.tsx";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { isCompactScale } from "../settings.ts";
import { type Palette } from "../themes.ts";
import { defaultCopyKeybind } from "../tui-config.ts";

export const HELP_WIDTH = 78;
export const HELP_STACK_BREAKPOINT = 56;
export const HELP_SECTION_BORDER = 2;
export const HELP_OVERLAY_BORDER = 2;
export const HELP_FOOTER_ROWS = 1;
export const HELP_SCROLL_PAGE = 8;
const KEY_COL_WIDTH = 16;
const PAIR_GAP = 2;
const STACKED_BLOCKS = 6;
const WIDE_BLOCKS = 4;

type Binding = {
  readonly key: string;
  readonly label: string;
};

export const HELP_NAVIGATION: readonly Binding[] = [
  { key: "tab", label: "next screen" },
  { key: "1-9,0", label: "jump to screen" },
  { key: "s/l/a/p/d/c/u", label: "letter jump (config, setup)" },
  { key: "j/k", label: "move selection" },
  { key: "esc", label: "back / close" },
];

export const HELP_SERVICES: readonly Binding[] = [
  { key: "enter", label: "start profile or open" },
  { key: "space", label: "multi-select" },
  { key: "n", label: "start" },
  { key: "x", label: "stop" },
  { key: "r", label: "refresh" },
  { key: "R", label: "restart" },
];

export function logBindings(copyKey: string): readonly Binding[] {
  return [
    { key: "←→", label: "filter services" },
    { key: "1-9", label: "jump to source" },
    { key: "e", label: "ERROR+ only" },
    { key: "g", label: "jump to latest" },
    { key: "p", label: "pause stream" },
    { key: "z", label: "full-screen logs" },
    { key: "f", label: "search" },
    { key: "t", label: "timestamps" },
    { key: "m", label: "metadata" },
    { key: "w", label: "clip / wrap selected / wrap all" },
    { key: "j/k", label: "move and unfold" },
    { key: copyKey, label: "copy visible logs" },
    { key: "/export", label: "write ~/.devctl/exports" },
    { key: "/exports", label: "open export folder" },
    { key: "ctrl+c ×2", label: "quit" },
  ];
}

export const HELP_COMMANDS: readonly Binding[] = [
  { key: "/", label: "slash command" },
  { key: "ctrl+p", label: "command palette" },
  { key: "ctrl+x", label: "leader chord" },
  { key: "/settings", label: "preferences · MCP page" },
  { key: "/themes", label: "preview themes" },
  { key: "/diff", label: "config sources" },
  { key: "/mcp", label: "agent MCP server" },
];

export const HELP_DISPLAY: readonly Binding[] = [
  { key: "ctrl+=", label: "larger" },
  { key: "ctrl+-", label: "smaller" },
  { key: "?", label: "this overlay" },
];

export function helpSectionHeight(bindingCount: number): number {
  return bindingCount + HELP_SECTION_BORDER;
}

export function helpOverlayHeight(input: {
  stacked: boolean;
  logCount: number;
  pad: number;
  gap: number;
}): number {
  const nav = helpSectionHeight(HELP_NAVIGATION.length);
  const services = helpSectionHeight(HELP_SERVICES.length);
  const logs = helpSectionHeight(input.logCount);
  const commands = helpSectionHeight(HELP_COMMANDS.length);
  const display = helpSectionHeight(HELP_DISPLAY.length);
  const chrome = HELP_OVERLAY_BORDER + input.pad * 2;
  if (input.stacked) {
    return chrome + nav + services + logs + commands + display + HELP_FOOTER_ROWS + (STACKED_BLOCKS - 1) * input.gap;
  }
  const top = Math.max(nav, services);
  const bottom = Math.max(commands, display);
  return chrome + top + logs + bottom + HELP_FOOTER_ROWS + (WIDE_BLOCKS - 1) * input.gap;
}

export function helpContentHeight(input: {
  stacked: boolean;
  logCount: number;
  pad: number;
  gap: number;
}): number {
  return helpOverlayHeight(input) - HELP_OVERLAY_BORDER - input.pad * 2;
}

export function helpIsStacked(termW: number): boolean {
  return termW - HELP_OVERLAY_BORDER * 2 < HELP_STACK_BREAKPOINT;
}

export function HelpOverlay(props: {
  palette: Palette;
  termW: number;
  termH: number;
  copyKey?: string;
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, termW, termH, copyKey = defaultCopyKeybind(), scrollRef } = props;
  const compact = isCompactScale(useDensity());
  const stacked = helpIsStacked(termW);
  const pad = compact ? 0 : 1;
  const gap = compact ? 0 : 1;
  const logs = logBindings(copyKey);
  const size = { stacked, logCount: logs.length, pad, gap };
  const preferH = helpOverlayHeight(size);
  const contentH = helpContentHeight(size);
  return (
    <OverlayShell
      palette={palette}
      title="help"
      bottomTitle={`${versionLine()}  ·  j/k scroll  ·  esc close`}
      termW={termW}
      termH={termH}
      preferW={HELP_WIDTH}
      preferH={preferH}
      gap={0}
    >
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box height={contentH} flexDirection="column" flexShrink={0} overflow="hidden" gap={gap}>
          {stacked ? (
            <>
              <HelpSection palette={palette} title="navigation" bindings={HELP_NAVIGATION} />
              <HelpSection palette={palette} title="services" bindings={HELP_SERVICES} />
              <HelpSection palette={palette} title="logs" bindings={logs} />
              <HelpSection palette={palette} title="commands" bindings={HELP_COMMANDS} />
              <HelpSection palette={palette} title="display" bindings={HELP_DISPLAY} />
            </>
          ) : (
            <>
              <HelpPair
                palette={palette}
                left={{ title: "navigation", bindings: HELP_NAVIGATION }}
                right={{ title: "services", bindings: HELP_SERVICES }}
              />
              <HelpSection palette={palette} title="logs" bindings={logs} />
              <HelpPair
                palette={palette}
                left={{ title: "commands", bindings: HELP_COMMANDS }}
                right={{ title: "display", bindings: HELP_DISPLAY }}
              />
            </>
          )}
          <box height={HELP_FOOTER_ROWS} flexShrink={0} overflow="hidden" paddingLeft={1}>
            <text fg={palette.muted} wrapMode="none">
              ~/.devctl/tui.json  ·  DEVCTL_TUI_CONFIG
            </text>
          </box>
        </box>
      </scrollbox>
    </OverlayShell>
  );
}

function HelpPair(props: {
  palette: Palette;
  left: { title: string; bindings: readonly Binding[] };
  right: { title: string; bindings: readonly Binding[] };
}) {
  const { palette, left, right } = props;
  const rowH = Math.max(helpSectionHeight(left.bindings.length), helpSectionHeight(right.bindings.length));
  return (
    <box height={rowH} flexDirection="row" flexShrink={0} overflow="hidden" gap={PAIR_GAP}>
      <HelpSection palette={palette} title={left.title} bindings={left.bindings} height={rowH} stretch />
      <HelpSection palette={palette} title={right.title} bindings={right.bindings} height={rowH} stretch />
    </box>
  );
}

function HelpSection(props: {
  palette: Palette;
  title: string;
  bindings: readonly Binding[];
  height?: number;
  stretch?: boolean;
}) {
  const { palette, title, bindings, stretch = false } = props;
  const height = props.height ?? helpSectionHeight(bindings.length);
  return (
    <box
      height={height}
      flexGrow={stretch ? 1 : 0}
      flexBasis={stretch ? 0 : undefined}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      border
      borderStyle="rounded"
      borderColor={palette.border}
      title={title}
      titleColor={palette.accent}
    >
      {bindings.map((binding) => (
        <box key={`${binding.key}-${binding.label}`} height={1} flexShrink={0} overflow="hidden" paddingLeft={1} paddingRight={1}>
          <HelpBind palette={palette} binding={binding} />
        </box>
      ))}
    </box>
  );
}

function HelpBind(props: { palette: Palette; binding: Binding }) {
  const { palette, binding } = props;
  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <box width={KEY_COL_WIDTH} flexShrink={0} overflow="hidden">
        <text fg={palette.primary} wrapMode="none">
          {binding.key}
        </text>
      </box>
      <box flexGrow={1} overflow="hidden">
        <text fg={palette.text} wrapMode="none">
          {binding.label}
        </text>
      </box>
    </box>
  );
}
