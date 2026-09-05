import { VERSION, versionLine } from "../../version.ts";
import { THEME_NAMES } from "./themes.ts";
import { DEFAULT_FONT_SIZE, DEFAULT_LEADER_TIMEOUT_MS, resolveTuiOverridePath, userTuiConfigPath } from "./tui-config.ts";

export const LEADER_STEPS_MS = [1000, 2000, 3000] as const;
export const FONT_SIZES = [12, 14, 16, 18, 20, 22] as const;
export const DEFAULT_THEME = "devctl";
export { DEFAULT_FONT_SIZE };

export type SettingsKind = "cycle" | "toggle" | "action" | "info" | "page";
export type SettingsGroup = "Appearance" | "Input" | "MCP" | "About";
export type SettingsId = "theme" | "font" | "mouse" | "leader" | "mcp" | "file" | "version" | "reset";

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
};

export function tuiPrefsLocked(): boolean {
  return resolveTuiOverridePath() !== undefined;
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
    ? "Applies this session only. DEVCTL_TUI_CONFIG overrides the user file."
    : `Saved to ${state.configPath}.`;
  return [
    {
      id: "theme",
      group: "Appearance",
      kind: "cycle",
      name: "Theme",
      value: state.themeName,
      hint: "← → save    enter  picker",
      detail: `Arrows write the theme to the user file. Enter opens the picker. ${persist}`,
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
      detail: `How long ctrl+x waits for the next key. ${persist}`,
    },
    {
      id: "mcp",
      group: "MCP",
      kind: "page",
      name: "Settings page",
      value: state.mcpRunning ? "running  →  /mcp" : "off  →  /mcp",
      hint: "enter  open the MCP page",
      detail: "Opens a dedicated MCP page (also /mcp or /agent). Start or stop the localhost server, change the port, and copy Claude, Cursor, Codex, and Kilo Code config.",
    },
    {
      id: "file",
      group: "About",
      kind: "info",
      name: "File",
      value: state.configPath,
      hint: "read-only",
      detail: state.locked
        ? `Using ${state.configPath} from DEVCTL_TUI_CONFIG.`
        : `User preferences live in ${state.configPath}.`,
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
      detail: `Restore theme ${DEFAULT_THEME}, display ${formatFontSize(DEFAULT_FONT_SIZE)}, mouse on, leader ${formatLeader(DEFAULT_LEADER_TIMEOUT_MS)}. Enter asks first. ${persist}`,
    },
  ];
}

export function settingsDefaults(): { theme: string; mouse: boolean; leader_timeout: number; font_size: number } {
  return { theme: DEFAULT_THEME, mouse: true, leader_timeout: DEFAULT_LEADER_TIMEOUT_MS, font_size: DEFAULT_FONT_SIZE };
}

export function groupedSettings(items: SettingsItem[]): { group: SettingsGroup; items: SettingsItem[] }[] {
  const order: SettingsGroup[] = ["Appearance", "Input", "MCP", "About"];
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

export function prefsSavePath(): string {
  return resolveTuiOverridePath() ?? userTuiConfigPath();
}
