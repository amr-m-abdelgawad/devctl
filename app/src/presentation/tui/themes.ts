import { hexLuminance, isLightPalette, resolveThemeName, themePalette, type Palette } from "../../domain/ui/themes.ts";
export {
  THEME_NAMES,
  THEME_BLURBS,
  resolveThemeName,
  themeBlurb,
  hexLuminance,
  isLightPalette,
  type ThemeName,
  type Palette,
} from "../../domain/ui/themes.ts";

function systemPrefersLight(): boolean {
  if (process.env.DEVCTL_THEME_LIGHT === "1") {
    return true;
  }
  if (process.env.DEVCTL_THEME_LIGHT === "0") {
    return false;
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(["defaults", "read", "-g", "AppleInterfaceStyle"], { stdout: "pipe", stderr: "pipe" });
      const out = result.stdout.toString();
      if (result.exitCode === 0 && out.toLowerCase().includes("dark")) {
        return false;
      }
      if (result.exitCode !== 0) {
        return true;
      }
    } catch {
      // fall through to COLORFGBG
    }
  }
  const fgbg = process.env.COLORFGBG ?? "";
  if (fgbg.includes(";15") || fgbg.endsWith(";7")) {
    return true;
  }
  if (fgbg.includes(";0") || fgbg.endsWith(";8")) {
    return false;
  }
  return false;
}

export function paletteFor(name: string): Palette {
  const resolved = resolveThemeName(name);
  if (resolved === "system" && systemPrefersLight()) return { ...themePalette("solarized-light"), name: "system" };
  return themePalette(resolved);
}

export function stateGlyph(state: string): string {
  switch (state.toUpperCase()) {
    case "HEALTHY":
    case "OK":
      return "✓";
    case "UNHEALTHY":
    case "WARNING":
    case "WARN":
      return "!";
    case "FAILED":
    case "ERROR":
      return "✗";
    case "STOPPED":
    case "UNKNOWN":
      return "○";
    case "RUNNING":
    case "STARTING":
    case "RESTARTING":
      return "●";
    default:
      return "○";
  }
}

const SERVICE_SWATCH_DARK = [
  "#7AA2F7",
  "#9ECE6A",
  "#E0AF68",
  "#BB9AF7",
  "#2AC3DE",
  "#FF9E64",
  "#F7768E",
  "#73DACA",
  "#C0CAF5",
  "#FF79C6",
  "#7DCFFF",
  "#C3E88D",
] as const;

const SERVICE_SWATCH_LIGHT = [
  "#2E5AAC",
  "#3D7A1F",
  "#9A6B12",
  "#6B3FA0",
  "#0E7A86",
  "#B85C1A",
  "#B4234A",
  "#1A7A6D",
  "#4A5080",
  "#9A3480",
  "#1565C0",
  "#4A7C19",
] as const;

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const LIGHT_BG_CUTOFF = 160;

export const CHIP_DARK_INK = "#1A1A1A";

export function chipForeground(background: string, fallback: string): string {
  return hexLuminance(background) >= LIGHT_BG_CUTOFF ? CHIP_DARK_INK : fallback;
}

function nameHash(value: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export type AgentBrandKind = "claude" | "cursor" | "kilo" | "codex";

const AGENT_BRAND: Record<AgentBrandKind, { dark: string; light: string }> = {
  claude: { dark: "#E08A6A", light: "#B54328" },
  cursor: { dark: "#B8D4FF", light: "#1E4EBF" },
  kilo: { dark: "#F0C94A", light: "#8A6400" },
  codex: { dark: "#4ADE80", light: "#0B7A4B" },
};

const ON_LIGHT_FILL = "#1A1A1A";
const ON_DARK_FILL = "#F5F5F5";

export function isDarkTerminalBackground(background: string | null | undefined): boolean {
  if (!background || !/^#[0-9a-f]{6}$/i.test(background)) {
    return false;
  }
  return hexLuminance(background) < LIGHT_BG_CUTOFF;
}

export function agentColor(kind: AgentBrandKind, palette: Palette): string {
  const pair = AGENT_BRAND[kind];
  return isLightPalette(palette) ? pair.light : pair.dark;
}

export function onAgentColor(kind: AgentBrandKind, palette: Palette): string {
  return hexLuminance(agentColor(kind, palette)) >= LIGHT_BG_CUTOFF ? ON_LIGHT_FILL : ON_DARK_FILL;
}

export function serviceColor(name: string, palette: Palette): string {
  if (name === "" || name === "all") {
    return palette.muted;
  }
  const swatch = hexLuminance(palette.background) >= LIGHT_BG_CUTOFF ? SERVICE_SWATCH_LIGHT : SERVICE_SWATCH_DARK;
  return swatch[nameHash(name) % swatch.length] ?? palette.info;
}

export function logMessageColor(palette: Palette, level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
    case "FATAL":
      return palette.error;
    case "WARN":
    case "WARNING":
      return palette.warning;
    case "INFO":
      return palette.text;
    case "DEBUG":
    case "TRACE":
      return palette.muted;
    default:
      return palette.text;
  }
}

export function logSpanColor(palette: Palette, level: string, kind: "text" | "string" | "keyword" | "number" | "search"): string {
  if (kind === "search") {
    return palette.search;
  }
  if (kind === "string") {
    return palette.accent;
  }
  if (kind === "number") {
    return palette.info;
  }
  if (kind === "keyword") {
    return palette.error;
  }
  return logMessageColor(palette, level);
}

export function stateColor(palette: Palette, state: string): string {
  switch (state.toUpperCase()) {
    case "HEALTHY":
    case "OK":
      return palette.success;
    case "UNHEALTHY":
    case "WARNING":
    case "WARN":
      return palette.warning;
    case "FAILED":
    case "ERROR":
      return palette.error;
    case "RUNNING":
    case "STARTING":
    case "RESTARTING":
      return palette.primary;
    case "INFO":
      return palette.info;
    case "FATAL":
      return palette.error;
    case "DEBUG":
    case "TRACE":
    case "UNKNOWN":
      return palette.muted;
    default:
      return palette.muted;
  }
}
