import { isLightPalette, resolveThemeName, themePalette, type ThemeName } from "../src/domain/ui/themes.ts";

type Appearance = "dark" | "light";
type Tokens = Record<string, string>;
const CACHE_KEY = "devctl.web.theme";
export const THEME_CHANGED_EVENT = "devctl:theme-change";

const PAIRS = [
  ["github-dark", "github-light"],
  ["rose-pine", "rose-pine-dawn"],
  ["claude-code", "claude-code-light"],
  ["catppuccin", "catppuccin-latte"],
  ["solarized-dark", "solarized-light"],
  ["voltage", "voltage-light"],
  ["ironclad", "ironclad-light"],
  ["signal", "signal-light"],
] as const;

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
function mix(from: string, to: string, amount: number): string {
  const right = rgb(to);
  return (
    "#" +
    rgb(from)
      .map((value, index) =>
        Math.round(value + ((right[index] ?? 0) - value) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function luminance(hex: string): number {
  const channels = rgb(hex).map((byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}
export function contrastRatio(a: string, b: string): number {
  const left = luminance(a),
    right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function readable(color: string, surfaces: string[], minimum = 4.5): string {
  const score = (candidate: string): number => Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)));
  if (score(color) >= minimum) return color;
  const ink = score("#000000") > score("#ffffff") ? "#000000" : "#ffffff";
  let low = 0,
    high = 1;
  for (let iteration = 0; iteration < 22; iteration++) {
    const middle = (low + high) / 2;
    if (score(mix(color, ink, middle)) >= minimum) high = middle;
    else low = middle;
  }
  return mix(color, ink, high);
}
function onColor(fill: string): string {
  return contrastRatio("#000000", fill) > contrastRatio("#ffffff", fill) ? "#000000" : "#ffffff";
}

export function themeDefaultAppearance(name: string): Appearance {
  return isLightPalette(themePalette(name)) ? "light" : "dark";
}

/** Native palette surfaces where available; adapt unpaired palettes to the requested appearance. */
export function webThemeTokens(name: string, appearance: Appearance): Tokens {
  const resolved = resolveThemeName(name);
  const pair = PAIRS.find((variants) => variants.some((variant) => variant === resolved));
  const palette = themePalette(
    pair ? pair[appearance === "light" ? 1 : 0] : resolved === "system" && appearance === "light" ? "solarized-light" : resolved,
  );
  const native = isLightPalette(palette) === (appearance === "light");
  const light = appearance === "light";
  const background = native ? palette.background : mix(light ? "#f5f7fa" : "#101218", palette.primary, 0.025);
  const card = native ? palette.panel : mix(light ? "#ffffff" : "#191d26", palette.primary, 0.025);
  const element = native ? palette.element : mix(light ? "#e9edf4" : "#252b36", palette.primary, 0.035);
  const highlight = native ? palette.highlight : mix(light ? "#dce2ed" : "#30394a", palette.primary, 0.06);
  const surfaces = [background, card, element, highlight];
  const foreground = readable(palette.text, surfaces);
  const primary = readable(palette.primary, surfaces);
  const error = readable(palette.error, surfaces);
  const tokens: Tokens = {
    "--background": background,
    "--foreground": foreground,
    "--card": card,
    "--card-foreground": foreground,
    "--elevated": element,
    "--popover": card,
    "--popover-foreground": foreground,
    "--primary": primary,
    "--primary-foreground": onColor(primary),
    "--secondary": element,
    "--secondary-foreground": foreground,
    "--muted": element,
    "--muted-foreground": readable(palette.muted, surfaces),
    "--accent": highlight,
    "--accent-foreground": foreground,
    "--destructive": error,
    "--destructive-foreground": onColor(error),
    "--border": readable(palette.border, [background, card, element], 1.5),
    "--input": readable(palette.border, [background, card, element], 3),
    "--ring": primary,
    "--success": readable(palette.success, surfaces),
    "--warning": readable(palette.warning, surfaces),
    "--info": readable(palette.info, surfaces),
    "--danger": error,
    "--theme-accent": readable(palette.accent, surfaces),
  };
  const logoPlateTint = light ? 0.16 : 0.24;
  const logoStrokeTint = 0.62;
  const logoMarkContrast = 3;
  const logoPlate = mix(background, primary, logoPlateTint);
  tokens["--logo-plate"] = logoPlate;
  tokens["--logo-stroke"] = mix(logoPlate, primary, logoStrokeTint);
  tokens["--logo-mark"] = readable(primary, [logoPlate], logoMarkContrast);
  const colors = [
    palette.primary,
    palette.info,
    palette.warning,
    palette.accent,
    palette.success,
    mix(palette.info, palette.accent, 0.4),
    mix(palette.primary, palette.warning, 0.4),
    mix(palette.success, palette.info, 0.5),
  ];
  colors.forEach((color, index) => {
    tokens["--service-" + index] = readable(color, [background, card, element]);
  });
  return tokens;
}

export function themeLabel(name: string): string {
  const resolved = resolveThemeName(name);
  const labels: Partial<Record<ThemeName, string>> = {
    devctl: "devctl",
    "claude-code": "Claude Code",
    "claude-code-light": "Claude Code Light",
    tokyonight: "Tokyo Night",
    catppuccin: "Catppuccin Mocha",
    "catppuccin-latte": "Catppuccin Latte",
    onedark: "One Dark",
    "rose-pine": "Rosé Pine",
    "github-dark": "GitHub Dark",
    "github-light": "GitHub Light",
    "rose-pine-dawn": "Rosé Pine Dawn",
    "synthwave-84": "SynthWave ’84",
  };
  return (
    labels[resolved] ??
    resolved
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export function applyWebTheme(name: string, appearance: Appearance): void {
  const root = document.documentElement;
  const theme = resolveThemeName(name);
  const tokens = webThemeTokens(theme, appearance);
  if (
    root.dataset.theme === theme &&
    root.dataset.appearance === appearance &&
    root.style.getPropertyValue("--background") === tokens["--background"]
  )
    return;
  root.dataset.theme = theme;
  root.dataset.appearance = appearance;
  Object.entries(tokens).forEach(([key, value]) => root.style.setProperty(key, value));
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, appearance }));
  } catch {
    /* Theme changes still work without storage. */
  }
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
}

export function restoreWebTheme(): void {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null") as { theme?: unknown; appearance?: unknown } | null;
    if (saved && typeof saved.theme === "string" && (saved.appearance === "dark" || saved.appearance === "light"))
      applyWebTheme(saved.theme, saved.appearance);
  } catch {
    /* The supervisor supplies the authoritative preference after loading. */
  }
}
