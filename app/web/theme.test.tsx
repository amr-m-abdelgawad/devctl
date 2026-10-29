import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { THEME_NAMES, themePalette } from "../src/domain/ui/themes.ts";
import { ThemePicker } from "./components/theme-picker.tsx";
import { contrastRatio, themeDefaultAppearance, themeLabel, webThemeTokens } from "./theme.ts";

test("the web exposes every TUI theme with a native preview, and the picker can be locked", () => {
  const html = renderToStaticMarkup(<ThemePicker value="dracula" disabled={false} onChange={() => {}} />);
  for (const name of THEME_NAMES) expect(html).toContain('aria-label="' + themeLabel(name) + '"');
  expect(html).toContain("28");
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
  expect(webThemeTokens("dracula", "light")["--background"]).not.toBe(webThemeTokens("dracula", "dark")["--background"]);
  for (const name of ["not-a-theme", "constructor", "__proto__"])
    expect(webThemeTokens(name, "dark")).toEqual(webThemeTokens("devctl", "dark"));
  expect(themeLabel("One Dark")).toBe("One Dark");
});

test("all 28 palettes in both appearances keep readable text, statuses, service colors, and filled buttons", () => {
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
    }
});
