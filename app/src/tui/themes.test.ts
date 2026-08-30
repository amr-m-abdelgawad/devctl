import { describe, expect, test } from "bun:test";
import { agentColor, hexLuminance, isLightPalette, logMessageColor, logSpanColor, onAgentColor, paletteFor, resolveThemeName, serviceColor, THEME_BLURBS, THEME_NAMES, themeBlurb } from "./themes.ts";

describe("themes", () => {
  test("every named theme has a palette and blurb", () => {
    for (const name of THEME_NAMES) {
      expect(paletteFor(name).name).toBe(name);
      expect(themeBlurb(name).length).toBeGreaterThan(0);
      expect(THEME_BLURBS[name]).toBe(themeBlurb(name));
    }
  });

  test("resolves common aliases and unknown names", () => {
    expect(resolveThemeName("One Dark")).toBe("onedark");
    expect(resolveThemeName("rose pine")).toBe("rose-pine");
    expect(resolveThemeName("latte")).toBe("catppuccin-latte");
    expect(resolveThemeName("solarized")).toBe("solarized-dark");
    expect(resolveThemeName("light")).toBe("system");
    expect(resolveThemeName("xterm")).toBe("terminal");
    expect(resolveThemeName("ansi")).toBe("terminal");
    expect(paletteFor("terminal").background).toBe("#000000");
    expect(resolveThemeName("not-a-theme")).toBe("devctl");
    expect(resolveThemeName("opencode")).toBe("ember");
    expect(paletteFor("github").primary).toBe(paletteFor("github-dark").primary);
  });

  test("service colors are stable and differ across names", () => {
    const dark = paletteFor("tokyonight");
    const light = paletteFor("catppuccin-latte");
    expect(serviceColor("auth", dark)).toBe(serviceColor("auth", dark));
    expect(serviceColor("auth", dark)).not.toBe(dark.muted);
    const spread = new Set(["auth", "api", "worker", "devctl", "proxy", "frontend"].map((name) => serviceColor(name, dark)));
    expect(spread.size).toBeGreaterThan(1);
    expect(serviceColor("auth", dark)).not.toBe(serviceColor("auth", light));
    expect(serviceColor("", dark)).toBe(dark.muted);
    expect(serviceColor("all", dark)).toBe(dark.muted);
  });

  test("agent brand colors stay distinct and readable on every theme", () => {
    const kinds = ["claude", "cursor", "kilo", "codex"] as const;
    const minGap = 40;
    for (const name of THEME_NAMES) {
      const palette = paletteFor(name);
      const light = isLightPalette(palette);
      const colors = kinds.map((kind) => agentColor(kind, palette));
      expect(new Set(colors).size).toBe(kinds.length);
      const bg = hexLuminance(palette.background);
      for (const kind of kinds) {
        const brand = agentColor(kind, palette);
        const fill = hexLuminance(brand);
        const onFill = hexLuminance(onAgentColor(kind, palette));
        expect(Math.abs(fill - bg)).toBeGreaterThan(minGap);
        expect(Math.abs(fill - onFill)).toBeGreaterThan(minGap);
        if (light) {
          expect(fill).toBeLessThan(bg);
        } else {
          expect(fill).toBeGreaterThan(bg);
        }
      }
    }
    expect(agentColor("claude", paletteFor("tokyonight"))).not.toBe(agentColor("claude", paletteFor("catppuccin-latte")));
  });

  test("log message colors follow level and token kind", () => {
    const dark = paletteFor("tokyonight");
    expect(logMessageColor(dark, "ERROR")).toBe(dark.error);
    expect(logMessageColor(dark, "WARN")).toBe(dark.warning);
    expect(logMessageColor(dark, "DEBUG")).toBe(dark.muted);
    expect(logSpanColor(dark, "INFO", "string")).toBe(dark.accent);
    expect(logSpanColor(dark, "INFO", "number")).toBe(dark.info);
    expect(logSpanColor(dark, "INFO", "keyword")).toBe(dark.error);
    expect(logSpanColor(dark, "ERROR", "text")).toBe(dark.error);
  });
});
