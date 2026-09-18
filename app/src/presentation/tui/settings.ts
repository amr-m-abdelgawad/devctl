import { VERSION, versionLine } from "../../version.ts";
import { THEME_NAMES } from "./themes.ts";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LEADER_TIMEOUT_MS,
  DEFAULT_SCROLL_SPEED,
  DEFAULT_WEB_APPEARANCE,
  displayWithMod,
  nearestScrollSpeed,
  preferenceResetPatch,
  SCROLL_SPEEDS,
  type PreferenceScope,
  type WebAppearance,
} from "./tui-config.ts";

export const LEADER_STEPS_MS = [1000, 2000, 3000] as const;
export const FONT_SIZES = [12, 14, 16, 18, 20, 22] as const;
export const DEFAULT_THEME = "devctl";
export { DEFAULT_FONT_SIZE };

export type SettingsKind = "cycle" | "toggle" | "action" | "info" | "page";
export type SettingsGroup = "Scope" | "Appearance" | "Input" | "Logs" | "Listeners" | "About";
export type SettingsId =
  | "scope"
  | "theme"
  | "font"
  | "web_appearance"
  | "mouse"
  | "leader"
  | "scroll"
  | "timestamps"
  | "metadata"
  | "mcp"
  | "web"
  | "web_port"
  | "user_file"
  | "repo_file"
  | "version"
  | "reset";

export type SettingsItem = {
  id: SettingsId;
  group: SettingsGroup;
  kind: SettingsKind;
  name: string;
  value: string;
  hint: string;
  detail: string;
};

export type SettingsState = {
  themeName: string;
  fontSize: number;
  mouse: boolean;
  leaderMs: number;
  locked: boolean;
  configPath: string;
  mcpRunning?: boolean;
  scope: PreferenceScope;
  scrollSpeed: number;
  logTimestamps: boolean;
  logMetadata: boolean;
  webAppearance: WebAppearance;
  webEnabled: boolean;
  webPort: number;
  webRunning?: boolean;
  userPath: string;
  repoPath: string;
  localPath: string;
};

export function tuiPrefsLocked(overridePath?: string): boolean {
  return overridePath !== undefined;
}

export function formatLeader(ms: number): string {
  const seconds = ms / 1000;
  if (Number.isInteger(seconds)) {
    return `${seconds}s`;
  }
  return `${ms}ms`;
}

export function cycleChoice<T>(items: readonly T[], current: T, dir: 1 | -1): T {
  const found = items.indexOf(current);
  const start = found < 0 ? 0 : found;
  const next = (start + dir + items.length) % items.length;
  return items[next] ?? items[0]!;
}

export function cycleTheme(current: string, dir: 1 | -1): string {
  const names = [...THEME_NAMES];
  const known = names.includes(current as (typeof THEME_NAMES)[number]) ? current : DEFAULT_THEME;
  return cycleChoice(names, known, dir);
}

export function cycleLeader(current: number, dir: 1 | -1): number {
  const steps = [...LEADER_STEPS_MS];
  const nearest = steps.reduce((best, step) => (Math.abs(step - current) < Math.abs(best - current) ? step : best), steps[0]!);
  return cycleChoice(steps, nearest, dir);
}

export function nearestFontSize(current: number): number {
  const steps = [...FONT_SIZES];
  return steps.reduce((best, step) => (Math.abs(step - current) < Math.abs(best - current) ? step : best), steps[0]!);
}

export function cycleFontSize(current: number, dir: 1 | -1): number {
  return cycleChoice([...FONT_SIZES], nearestFontSize(current), dir);
}

export function cycleScrollSpeed(current: number, dir: 1 | -1): number {
  return cycleChoice([...SCROLL_SPEEDS], nearestScrollSpeed(current), dir);
}

export function cycleWebAppearance(current: WebAppearance, dir: 1 | -1): WebAppearance {
  return cycleChoice(["dark", "light"] as const, current, dir);
}

export function cyclePreferenceScope(current: PreferenceScope, dir: 1 | -1): PreferenceScope {
  return cycleChoice(["repo", "user"] as const, current, dir);
}

export function formatScrollSpeed(speed: number): string {
  return `${nearestScrollSpeed(speed)}`;
}

export function formatScope(scope: PreferenceScope): string {
  return scope === "repo" ? "this repo" : "all repos";
}

export type UiScale = {
  px: number;
  pad: number;
  rowH: number;
  gap: number;
  steps: number;
  label: string;
};

const SCALE_BY_PX: Record<(typeof FONT_SIZES)[number], Omit<UiScale, "px">> = {
  12: { pad: 0, rowH: 1, gap: 0, steps: 1, label: "compact" },
  14: { pad: 0, rowH: 1, gap: 0, steps: 2, label: "default" },
  16: { pad: 1, rowH: 1, gap: 1, steps: 3, label: "comfortable" },
  18: { pad: 1, rowH: 2, gap: 1, steps: 4, label: "large" },
  20: { pad: 2, rowH: 2, gap: 1, steps: 5, label: "xl" },
  22: { pad: 2, rowH: 2, gap: 2, steps: 6, label: "xxl" },
};

export function uiScaleFor(size: number): UiScale {
  const px = nearestFontSize(size);
  const found = SCALE_BY_PX[px as (typeof FONT_SIZES)[number]] ?? SCALE_BY_PX[DEFAULT_FONT_SIZE];
  return { px, ...found };
}

export function isCompactScale(scale: UiScale): boolean {
  return scale.label === "compact";
}

export function isTightScale(scale: UiScale): boolean {
  return scale.steps <= 2;
}

export function sizeMeter(steps: number): string {
  const cells = FONT_SIZES.map((_, index) => (index < steps ? "█" : "░"));
  return cells.join(" ");
}

export function formatFontSize(size: number): string {
  return uiScaleFor(size).label;
}

export function settingsItems(state: SettingsState): SettingsItem[] {
  const persist = state.locked
    ? "Applies this session only. DEVCTL_TUI_CONFIG overrides saved files."
    : `Saved to ${state.configPath}.`;
  const scopeHint = state.scope === "repo" ? "this repository overlay" : "your user tui.json (every checkout)";
  return [
    {
      id: "scope",
      group: "Scope",
      kind: "cycle",
      name: "Save to",
      value: formatScope(state.scope),
      hint: "← →  this repo / all repos",
      detail: state.locked
        ? `DEVCTL_TUI_CONFIG is set — writes stay in this session. Would have written ${state.configPath}.`
        : `This repository writes ${state.repoPath}. All repositories writes ${state.userPath}. Current writes go to ${state.configPath}.`,
    },
    {
      id: "theme",
      group: "Appearance",
      kind: "cycle",
      name: "Theme",
      value: state.themeName,
      hint: "← → save    enter  picker",
      detail: `Arrows write the theme to ${scopeHint}. Enter opens the picker. ${persist}`,
    },
    {
      id: "font",
      group: "Appearance",
      kind: "cycle",
      name: "Display size",
      value: formatFontSize(state.fontSize),
      hint: "← → save",
      detail: `Scales content padding and list-row height. Default keeps a thin rule between chrome and panes. Compact sits toolbars flush against borders. Header, nav, and status stay one line. Does not change the terminal font. ${persist}`,
    },
    {
      id: "web_appearance",
      group: "Appearance",
      kind: "cycle",
      name: "Web console",
      value: state.webAppearance,
      hint: "← → save",
      detail: `Dark or light tokens for the loopback web console. Does not change this TUI theme. ${persist}`,
    },
    {
      id: "mouse",
      group: "Input",
      kind: "toggle",
      name: "Mouse",
      value: state.mouse ? "on" : "off",
      hint: "space or enter  toggle",
      detail: `Clicks on nav and lists. Restart the TUI after a change. ${persist}`,
    },
    {
      id: "leader",
      group: "Input",
      kind: "cycle",
      name: "Leader",
      value: formatLeader(state.leaderMs),
      hint: "← → save",
      detail: `How long ${displayWithMod("x")} waits for the next key. ${persist}`,
    },
    {
      id: "scroll",
      group: "Input",
      kind: "cycle",
      name: "Scroll speed",
      value: formatScrollSpeed(state.scrollSpeed),
      hint: "← → save",
      detail: `Lines moved by j/k and wheel in scrollable panes. ${persist}`,
    },
    {
      id: "timestamps",
      group: "Logs",
      kind: "toggle",
      name: "Timestamps",
      value: state.logTimestamps ? "on" : "off",
      hint: "space or enter  toggle",
      detail: `Same as t on the logs screen. ${persist}`,
    },
    {
      id: "metadata",
      group: "Logs",
      kind: "toggle",
      name: "Metadata",
      value: state.logMetadata ? "on" : "off",
      hint: "space or enter  toggle",
      detail: `Same as m on the logs screen. ${persist}`,
    },
    {
      id: "mcp",
      group: "Listeners",
      kind: "page",
      name: "MCP",
      value: state.mcpRunning ? "running  →  /mcp" : "off  →  /mcp",
      hint: "enter  open the MCP page",
      detail: "Opens the MCP page (also /mcp or /agent). Listen, port, and tool lists save to this repository overlay.",
    },
    {
      id: "web",
      group: "Listeners",
      kind: "toggle",
      name: "Web console",
      value: state.webEnabled ? (state.webRunning ? "on · listening" : "on") : "off",
      hint: "space or enter  toggle",
      detail: `Writes web.enabled to ${state.localPath}, then reloads so the listener starts or stops. Hand-edited keys in that overlay stay.`,
    },
    {
      id: "web_port",
      group: "Listeners",
      kind: "cycle",
      name: "Web port",
      value: String(state.webPort),
      hint: "← → preview    enter  save",
      detail: "Arrows preview web.listen.port. Enter writes .devctl/config.local.yaml (loopback host unchanged) and reloads. Other YAML keys are left alone.",
    },
    {
      id: "user_file",
      group: "About",
      kind: "info",
      name: "User file",
      value: state.userPath,
      hint: "read-only",
      detail: `Defaults for every checkout. ${state.locked ? `Overridden this session by ${state.configPath}.` : "Theme and input follow the Save to toggle."}`,
    },
    {
      id: "repo_file",
      group: "About",
      kind: "info",
      name: "Repo file",
      value: state.repoPath,
      hint: "read-only",
      detail: "Per-checkout overlay. MCP listen always lands here. Later sources win.",
    },
    {
      id: "version",
      group: "About",
      kind: "info",
      name: "Version",
      value: VERSION,
      hint: "read-only",
      detail: versionLine(),
    },
    {
      id: "reset",
      group: "About",
      kind: "action",
      name: "Reset",
      value: "defaults",
      hint: "enter  confirm reset",
      detail: `Restore theme ${DEFAULT_THEME}, display ${formatFontSize(DEFAULT_FONT_SIZE)}, mouse on, leader ${formatLeader(DEFAULT_LEADER_TIMEOUT_MS)}, scroll ${DEFAULT_SCROLL_SPEED}, log columns on, web console ${DEFAULT_WEB_APPEARANCE}. Applies to ${scopeHint}. MCP listen is left as-is. ${persist}`,
    },
  ];
}

export function settingsDefaults(): ReturnType<typeof preferenceResetPatch> {
  return preferenceResetPatch();
}

export function groupedSettings(items: SettingsItem[]): { group: SettingsGroup; items: SettingsItem[] }[] {
  const order: SettingsGroup[] = ["Scope", "Appearance", "Input", "Logs", "Listeners", "About"];
  return order.flatMap((group) => {
    const rows = items.filter((item) => item.group === group);
    if (rows.length === 0) {
      return [];
    }
    return [{ group, items: rows }];
  });
}

export function settingsIndex(items: SettingsItem[], selected: number): number {
  if (items.length === 0) {
    return 0;
  }
  return Math.min(Math.max(selected, 0), items.length - 1);
}

export function selectedSettingsItem(items: SettingsItem[], selected: number): SettingsItem | undefined {
  return items[settingsIndex(items, selected)];
}

export function prefsSavePath(overridePath: string | undefined, userPath: string): string {
  return overridePath ?? userPath;
}
