import { describe, expect, test } from "bun:test";
import { DEFAULT_LEADER_TIMEOUT_MS } from "./tui-config.ts";
import {
  cycleFontSize,
  cycleLeader,
  cyclePreferenceScope,
  cycleScrollSpeed,
  cycleTheme,
  FONT_SIZES,
  formatFontSize,
  formatLeader,
  formatScope,
  groupedSettings,
  selectedSettingsItem,
  settingsDefaults,
  settingsIndex,
  settingsItems,
  sizeMeter,
  tuiPrefsLocked,
  isCompactScale,
  isTightScale,
  uiScaleFor,
  type SettingsState,
} from "./settings.ts";

function sampleState(partial: Partial<SettingsState> = {}): SettingsState {
  return {
    themeName: "nord",
    fontSize: 14,
    mouse: true,
    leaderMs: 2000,
    locked: false,
    configPath: "/tmp/state/repo/tui.json",
    scope: "repo",
    scrollSpeed: 3,
    logTimestamps: true,
    logMetadata: true,
    webAppearance: "dark",
    webEnabled: false,
    webPort: 18900,
    inspectMaxBytes: 1_048_576,
    userPath: "/tmp/home/tui.json",
    repoPath: "/tmp/state/repo/tui.json",
    localPath: "/tmp/repo/.devctl/config.local.yaml",
    ...partial,
  };
}

const sample = settingsItems(sampleState());

describe("settings", () => {
  test("groups scope, appearance, input, logs, listeners, then about", () => {
    expect(groupedSettings(sample).map((section) => section.group)).toEqual([
      "Scope",
      "Appearance",
      "Input",
      "Logs",
      "Listeners",
      "About",
    ]);
  });

  test("mcp row is a page link to /mcp under listeners", () => {
    const mcp = sample.find((item) => item.id === "mcp");
    expect(mcp?.kind).toBe("page");
    expect(mcp?.group).toBe("Listeners");
    expect(mcp?.name).toBe("MCP");
    expect(mcp?.value).toContain("/mcp");
    expect(mcp?.value).toContain("→");
    const running = settingsItems(sampleState({ mcpRunning: true })).find((item) => item.id === "mcp");
    expect(running?.value).toContain("running");
  });

  test("scope and log columns are first-class rows", () => {
    expect(sample.find((item) => item.id === "scope")?.value).toBe("this repo");
    expect(settingsItems(sampleState({ scope: "user" })).find((item) => item.id === "scope")?.value).toBe("all repos");
    expect(sample.find((item) => item.id === "scroll")?.value).toBe("3");
    expect(sample.find((item) => item.id === "timestamps")?.kind).toBe("toggle");
    expect(sample.find((item) => item.id === "web")?.kind).toBe("toggle");
    expect(sample.find((item) => item.id === "web_port")?.value).toBe("18900");
    expect(sample.find((item) => item.id === "web_port")?.hint).toContain("preview");
    expect(sample.find((item) => item.id === "inspect_cap")?.value).toBe("1 MiB");
    expect(sample.find((item) => item.id === "inspect_cap")?.kind).toBe("cycle");
    expect(formatScope("repo")).toBe("this repo");
    expect(cyclePreferenceScope("repo", 1)).toBe("user");
    expect(cycleScrollSpeed(3, 1)).toBe(4);
  });

  test("theme and leader cycle wrap", () => {
    expect(cycleTheme("devctl", -1)).toBe("system");
    expect(cycleTheme("system", 1)).toBe("devctl");
    expect(cycleTheme("unknown", 1)).not.toBe("unknown");
    expect(cycleLeader(2000, 1)).toBe(3000);
    expect(cycleLeader(3000, 1)).toBe(1000);
    expect(formatLeader(DEFAULT_LEADER_TIMEOUT_MS)).toBe("2s");
    expect(cycleFontSize(14, 1)).toBe(16);
    expect(cycleFontSize(22, 1)).toBe(12);
    expect(formatFontSize(15)).toBe("default");
    expect(formatFontSize(22)).toBe("xxl");
    expect(uiScaleFor(12)).toMatchObject({ pad: 0, rowH: 1, gap: 0, steps: 1 });
    expect(isCompactScale(uiScaleFor(12))).toBe(true);
    expect(isCompactScale(uiScaleFor(14))).toBe(false);
    expect(isTightScale(uiScaleFor(12))).toBe(true);
    expect(isTightScale(uiScaleFor(14))).toBe(true);
    expect(isTightScale(uiScaleFor(16))).toBe(false);
    expect(uiScaleFor(14)).toMatchObject({ pad: 0, rowH: 1, gap: 0, steps: 2 });
    expect(uiScaleFor(16)).toMatchObject({ pad: 1, rowH: 1, gap: 1, steps: 3 });
    expect(uiScaleFor(18)).toMatchObject({ pad: 1, rowH: 2, gap: 1, steps: 4 });
    expect(uiScaleFor(20)).toMatchObject({ pad: 2, rowH: 2, gap: 1, steps: 5 });
    expect(uiScaleFor(22)).toMatchObject({ pad: 2, rowH: 2, gap: 2, steps: 6 });
    const keys = FONT_SIZES.map((px) => {
      const scale = uiScaleFor(px);
      return `${scale.pad}:${scale.rowH}:${scale.gap}:${scale.steps}`;
    });
    expect(new Set(keys).size).toBe(FONT_SIZES.length);
    expect(sizeMeter(2)).toBe("█ █ ░ ░ ░ ░");
    expect(sizeMeter(6)).toBe("█ █ █ █ █ █");
  });

  test("selection clamps and names the current row", () => {
    expect(settingsIndex(sample, 99)).toBe(sample.length - 1);
    expect(selectedSettingsItem(sample, 0)?.id).toBe("scope");
    expect(selectedSettingsItem(sample, 1)?.id).toBe("theme");
    expect(selectedSettingsItem(sample, 2)?.id).toBe("font");
  });

  test("locked copy says session only", () => {
    const locked = settingsItems(sampleState({
      locked: true,
      fontSize: 16,
      mouse: false,
      leaderMs: 1000,
      configPath: "/tmp/override.json",
    }));
    expect(locked[0]?.detail).toContain("DEVCTL_TUI_CONFIG");
    expect(settingsDefaults().theme).toBe("devctl");
    expect(settingsDefaults().scroll_speed).toBe(3);
  });

  test("prefs lock only when an override path was resolved", () => {
    expect(tuiPrefsLocked(undefined)).toBe(false);
    expect(tuiPrefsLocked("/tmp/override.json")).toBe(true);
  });
});
