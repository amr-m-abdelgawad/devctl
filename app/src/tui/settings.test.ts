import { describe, expect, test } from "bun:test";
import { DEFAULT_LEADER_TIMEOUT_MS } from "./tui-config.ts";
import {
  cycleFontSize,
  cycleLeader,
  cycleTheme,
  FONT_SIZES,
  formatFontSize,
  formatLeader,
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
} from "./settings.ts";

const sample = settingsItems({
  themeName: "nord",
  fontSize: 14,
  mouse: true,
  leaderMs: 2000,
  locked: false,
  configPath: "/tmp/tui.json",
});

describe("settings", () => {
  test("groups appearance, input, mcp, then about", () => {
    expect(groupedSettings(sample).map((section) => section.group)).toEqual(["Appearance", "Input", "MCP", "About"]);
  });

  test("mcp row is a page link to /mcp", () => {
    const mcp = sample.find((item) => item.id === "mcp");
    expect(mcp?.kind).toBe("page");
    expect(mcp?.group).toBe("MCP");
    expect(mcp?.name).toBe("Settings page");
    expect(mcp?.value).toContain("/mcp");
    expect(mcp?.value).toContain("→");
    expect(mcp?.detail).toContain("dedicated MCP page");
    const running = settingsItems({
      themeName: "nord",
      fontSize: 14,
      mouse: true,
      leaderMs: 2000,
      locked: false,
      configPath: "/tmp/tui.json",
      mcpRunning: true,
    }).find((item) => item.id === "mcp");
    expect(running?.value).toContain("running");
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
    expect(selectedSettingsItem(sample, 0)?.id).toBe("theme");
    expect(selectedSettingsItem(sample, 1)?.id).toBe("font");
    expect(selectedSettingsItem(sample, 2)?.kind).toBe("toggle");
  });

  test("locked copy says session only", () => {
    const locked = settingsItems({
      themeName: "nord",
      fontSize: 16,
      mouse: false,
      leaderMs: 1000,
      locked: true,
      configPath: "/tmp/override.json",
    });
    expect(locked[0]?.detail).toContain("DEVCTL_TUI_CONFIG");
    expect(settingsDefaults().theme).toBe("devctl");
  });

  test("prefs lock only when DEVCTL_TUI_CONFIG points at a real file", () => {
    const prev = process.env.DEVCTL_TUI_CONFIG;
    process.env.DEVCTL_TUI_CONFIG = "/tmp/devctl-missing-tui-config.json";
    try {
      expect(tuiPrefsLocked()).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.DEVCTL_TUI_CONFIG;
      } else {
        process.env.DEVCTL_TUI_CONFIG = prev;
      }
    }
  });
});
