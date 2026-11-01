import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { THEME_NAMES, themePalette } from "../src/domain/ui/themes.ts";
import { DevctlLogo } from "./brand.tsx";
import { ThemePicker } from "./components/theme-picker.tsx";
import { contrastRatio, themeDefaultAppearance, themeLabel, webThemeTokens } from "./theme.ts";

test("the web exposes every TUI theme with a native preview, and the picker can be locked", () => {
  const html = renderToStaticMarkup(<ThemePicker value="dracula" disabled={false} onChange={() => {}} />);
  for (const name of THEME_NAMES) expect(html).toContain('aria-label="' + themeLabel(name) + '"');
  expect(html).toContain(String(THEME_NAMES.length));
  expect(html).toContain('data-state="on"');
  const locked = renderToStaticMarkup(<ThemePicker value="devctl" disabled onChange={() => {}} />);
  expect(locked).toContain("disabled");
});

test("native palettes preserve their canvas and named light/dark variants work in either mode", () => {
  expect(webThemeTokens("dracula", "dark")["--background"]).toBe(themePalette("dracula").background);
  expect(webThemeTokens("catppuccin", "light")["--background"]).toBe(themePalette("catppuccin-latte").background);
  expect(webThemeTokens("catppuccin-latte", "dark")["--background"]).toBe(themePalette("catppuccin").background);
  expect(webThemeTokens("system", "light")["--background"]).toBe(themePalette("solarized-light").background);
  expect(themeDefaultAppearance("voltage-light")).toBe("light");
  expect(themeDefaultAppearance("tokyonight")).toBe("dark");
  expect(themeDefaultAppearance("claude-code")).toBe("dark");
  expect(themeDefaultAppearance("claude-code-light")).toBe("light");
  expect(webThemeTokens("claude-code", "light")["--background"]).toBe(themePalette("claude-code-light").background);
  expect(webThemeTokens("claude-code-light", "dark")["--background"]).toBe(themePalette("claude-code").background);
  expect(themeLabel("claude-code")).toBe("Claude Code");
  expect(themeLabel("claude-code-light")).toBe("Claude Code Light");
  expect(webThemeTokens("dracula", "light")["--background"]).not.toBe(webThemeTokens("dracula", "dark")["--background"]);
  for (const name of ["not-a-theme", "constructor", "__proto__"])
    expect(webThemeTokens(name, "dark")).toEqual(webThemeTokens("devctl", "dark"));
  expect(themeLabel("One Dark")).toBe("One Dark");
});

test("new palettes retain native appearances and pair with their existing dark themes", () => {
  for (const [dark, light] of [["github-dark", "github-light"], ["rose-pine", "rose-pine-dawn"]] as const) {
    expect(themeDefaultAppearance(light)).toBe("light");
    expect(webThemeTokens(dark, "light")["--background"]).toBe(themePalette(light).background);
    expect(webThemeTokens(light, "dark")["--background"]).toBe(themePalette(dark).background);
  }
  expect(themeDefaultAppearance("synthwave-84")).toBe("dark");
  expect(webThemeTokens("synthwave-84", "dark")["--background"]).toBe(themePalette("synthwave-84").background);
  expect(themeLabel("github-light")).toBe("GitHub Light");
  expect(themeLabel("rose-pine-dawn")).toBe("Rosé Pine Dawn");
  expect(themeLabel("synthwave-84")).toBe("SynthWave ’84");
});

test("all palettes in both appearances keep readable text, statuses, service colors, and filled buttons", () => {
  expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  for (const name of THEME_NAMES)
    for (const appearance of ["light", "dark"] as const) {
      const tokens = webThemeTokens(name, appearance);
      for (const value of Object.values(tokens)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      for (const fg of ["--foreground", "--muted-foreground", "--primary", "--success", "--warning", "--info", "--danger"]) {
        for (const bg of ["--background", "--card", "--muted", "--accent"])
          expect(contrastRatio(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
      }
      for (let index = 0; index < 8; index++)
        for (const bg of ["--background", "--card", "--muted"])
          expect(contrastRatio(tokens["--service-" + index]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["--primary"]!, tokens["--primary-foreground"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["--destructive"]!, tokens["--destructive-foreground"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["--logo-mark"]!, tokens["--logo-plate"]!)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tokens["--logo-stroke"]!, tokens["--card"]!)).toBeGreaterThanOrEqual(2);
    }
});

test("the sidebar logo recolors with the theme and keeps the brand geometry", () => {
  const html = renderToStaticMarkup(<DevctlLogo />);
  expect(html).toContain('fill="var(--logo-plate, #18372f)"');
  expect(html).toContain('stroke="var(--logo-stroke, #087568)"');
  expect(html).toContain('stroke="var(--logo-mark, #77ddba)"');
  expect(html).toContain('fill="var(--logo-mark, #77ddba)"');
  expect(webThemeTokens("dracula", "dark")["--logo-mark"]?.toLowerCase()).not.toBe(
    webThemeTokens("devctl", "dark")["--logo-mark"]?.toLowerCase(),
  );
  expect(webThemeTokens("devctl", "light")["--logo-plate"]).not.toBe(webThemeTokens("devctl", "dark")["--logo-plate"]);
});
