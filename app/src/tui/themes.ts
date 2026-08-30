export type Palette = {
  name: string;
  primary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  text: string;
  muted: string;
  background: string;
  panel: string;
  element: string;
  highlight: string;
  inverse: string;
  border: string;
  borderActive: string;
};

export const THEME_NAMES = [
  "devctl",
  "ember",
  "tokyonight",
  "catppuccin",
  "catppuccin-latte",
  "nord",
  "gruvbox",
  "kanagawa",
  "dracula",
  "onedark",
  "monokai",
  "solarized-dark",
  "solarized-light",
  "rose-pine",
  "everforest",
  "github-dark",
  "iceberg",
  "ayu-dark",
  "oxocarbon",
  "night-owl",
  "terminal",
  "system",
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export const THEME_BLURBS: Record<ThemeName, string> = {
  devctl: "amber + cyan, product theme",
  ember: "warm orange",
  tokyonight: "Tokyo Night storm blues",
  catppuccin: "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte (light)",
  nord: "Arctic Nord frost",
  gruvbox: "Gruvbox dark hard",
  kanagawa: "Kanagawa wave / gold",
  dracula: "classic Dracula purple",
  onedark: "Atom / VS Code One Dark",
  monokai: "Monokai Sublime",
  "solarized-dark": "Solarized dark",
  "solarized-light": "Solarized light",
  "rose-pine": "Rosé Pine moon",
  everforest: "Everforest dark medium",
  "github-dark": "GitHub dimmed canvas",
  iceberg: "Iceberg navy",
  "ayu-dark": "Ayu Mirage-adjacent dark",
  oxocarbon: "IBM Oxocarbon",
  "night-owl": "Sarah Drasner Night Owl",
  terminal: "black + VGA ANSI chrome",
  system: "neutral dark (system default)",
};

const PALETTES: Record<ThemeName, Palette> = {
  tokyonight: {
    name: "tokyonight",
    primary: "#82AAFF",
    accent: "#C792EA",
    error: "#FF5370",
    warning: "#FFCB6B",
    success: "#C3E88D",
    info: "#89DDFF",
    text: "#F4F7FF",
    muted: "#A8B2CC",
    background: "#0F111A",
    panel: "#1A1B2E",
    element: "#24283B",
    highlight: "#2E3350",
    inverse: "#0F111A",
    border: "#3D4466",
    borderActive: "#82AAFF",
  },
  catppuccin: {
    name: "catppuccin",
    primary: "#89B4FA",
    accent: "#F5C2E7",
    error: "#F38BA8",
    warning: "#F9E2AF",
    success: "#A6E3A1",
    info: "#89DCEB",
    text: "#E4E8F7",
    muted: "#A6A9BE",
    background: "#11111B",
    panel: "#1E1E2E",
    element: "#313244",
    highlight: "#45475A",
    inverse: "#11111B",
    border: "#585B70",
    borderActive: "#89B4FA",
  },
  "catppuccin-latte": {
    name: "catppuccin-latte",
    primary: "#1E66F5",
    accent: "#EA76CB",
    error: "#D20F39",
    warning: "#DF8E1D",
    success: "#40A02B",
    info: "#179299",
    text: "#4C4F69",
    muted: "#6C6F85",
    background: "#EFF1F5",
    panel: "#E6E9EF",
    element: "#DCE0E8",
    highlight: "#CCD0DA",
    inverse: "#EFF1F5",
    border: "#9CA0B0",
    borderActive: "#1E66F5",
  },
  nord: {
    name: "nord",
    primary: "#88C0D0",
    accent: "#B48EAD",
    error: "#BF616A",
    warning: "#EBCB8B",
    success: "#A3BE8C",
    info: "#8FBCBB",
    text: "#F2F5FA",
    muted: "#A4AEBF",
    background: "#2E3440",
    panel: "#3B4252",
    element: "#434C5E",
    highlight: "#4C566A",
    inverse: "#2E3440",
    border: "#5E6A7D",
    borderActive: "#88C0D0",
  },
  gruvbox: {
    name: "gruvbox",
    primary: "#FE8019",
    accent: "#FABD2F",
    error: "#FB4934",
    warning: "#FE8019",
    success: "#B8BB26",
    info: "#8EC07C",
    text: "#F2E5BC",
    muted: "#C4B394",
    background: "#1D2021",
    panel: "#282828",
    element: "#3C3836",
    highlight: "#504945",
    inverse: "#1D2021",
    border: "#665C54",
    borderActive: "#FE8019",
  },
  kanagawa: {
    name: "kanagawa",
    primary: "#7FB4CA",
    accent: "#E6C384",
    error: "#E82424",
    warning: "#FFA066",
    success: "#98BB6C",
    info: "#7FB4CA",
    text: "#E8E4C9",
    muted: "#B4C0D6",
    background: "#16161D",
    panel: "#1F1F28",
    element: "#2A2A37",
    highlight: "#363646",
    inverse: "#16161D",
    border: "#54546D",
    borderActive: "#E6C384",
  },
  dracula: {
    name: "dracula",
    primary: "#BD93F9",
    accent: "#FF79C6",
    error: "#FF5555",
    warning: "#F1FA8C",
    success: "#50FA7B",
    info: "#8BE9FD",
    text: "#F8F8F2",
    muted: "#6272A4",
    background: "#21222C",
    panel: "#282A36",
    element: "#343746",
    highlight: "#44475A",
    inverse: "#21222C",
    border: "#6272A4",
    borderActive: "#BD93F9",
  },
  onedark: {
    name: "onedark",
    primary: "#61AFEF",
    accent: "#C678DD",
    error: "#E06C75",
    warning: "#E5C07B",
    success: "#98C379",
    info: "#56B6C2",
    text: "#ABB2BF",
    muted: "#5C6370",
    background: "#21252B",
    panel: "#282C34",
    element: "#2C323C",
    highlight: "#3E4451",
    inverse: "#21252B",
    border: "#4B5263",
    borderActive: "#61AFEF",
  },
  monokai: {
    name: "monokai",
    primary: "#66D9EF",
    accent: "#AE81FF",
    error: "#F92672",
    warning: "#E6DB74",
    success: "#A6E22E",
    info: "#66D9EF",
    text: "#F8F8F2",
    muted: "#75715E",
    background: "#1D1E19",
    panel: "#272822",
    element: "#3E3D32",
    highlight: "#49483E",
    inverse: "#1D1E19",
    border: "#75715E",
    borderActive: "#F92672",
  },
  "solarized-dark": {
    name: "solarized-dark",
    primary: "#268BD2",
    accent: "#6C71C4",
    error: "#DC322F",
    warning: "#B58900",
    success: "#859900",
    info: "#2AA198",
    text: "#93A1A1",
    muted: "#586E75",
    background: "#002B36",
    panel: "#073642",
    element: "#0A4A58",
    highlight: "#1A5A68",
    inverse: "#002B36",
    border: "#586E75",
    borderActive: "#268BD2",
  },
  "solarized-light": {
    name: "solarized-light",
    primary: "#268BD2",
    accent: "#D33682",
    error: "#DC322F",
    warning: "#CB4B16",
    success: "#859900",
    info: "#2AA198",
    text: "#586E75",
    muted: "#839496",
    background: "#FDF6E3",
    panel: "#EEE8D5",
    element: "#E4DCC8",
    highlight: "#D5CDB6",
    inverse: "#FDF6E3",
    border: "#93A1A1",
    borderActive: "#268BD2",
  },
  "rose-pine": {
    name: "rose-pine",
    primary: "#C4A7E7",
    accent: "#EBBCBA",
    error: "#EB6F92",
    warning: "#F6C177",
    success: "#31748F",
    info: "#9CCFD8",
    text: "#E0DEF4",
    muted: "#908CAA",
    background: "#191724",
    panel: "#1F1D2E",
    element: "#26233A",
    highlight: "#403D52",
    inverse: "#191724",
    border: "#6E6A86",
    borderActive: "#C4A7E7",
  },
  everforest: {
    name: "everforest",
    primary: "#7FBBB3",
    accent: "#D699B6",
    error: "#E67E80",
    warning: "#DBBC7F",
    success: "#A7C080",
    info: "#83C092",
    text: "#D3C6AA",
    muted: "#9DA9A0",
    background: "#232A2E",
    panel: "#2D353B",
    element: "#343F44",
    highlight: "#3D484D",
    inverse: "#232A2E",
    border: "#4F585E",
    borderActive: "#A7C080",
  },
  "github-dark": {
    name: "github-dark",
    primary: "#58A6FF",
    accent: "#A371F7",
    error: "#F85149",
    warning: "#D29922",
    success: "#3FB950",
    info: "#79C0FF",
    text: "#E6EDF3",
    muted: "#8B949E",
    background: "#0D1117",
    panel: "#161B22",
    element: "#21262D",
    highlight: "#30363D",
    inverse: "#0D1117",
    border: "#30363D",
    borderActive: "#58A6FF",
  },
  iceberg: {
    name: "iceberg",
    primary: "#84A0C6",
    accent: "#A093C7",
    error: "#E27878",
    warning: "#E2A478",
    success: "#B4BE82",
    info: "#89B8C2",
    text: "#C6C8D1",
    muted: "#6B7089",
    background: "#161821",
    panel: "#1E2132",
    element: "#2A3150",
    highlight: "#3D425B",
    inverse: "#161821",
    border: "#444B71",
    borderActive: "#84A0C6",
  },
  "ayu-dark": {
    name: "ayu-dark",
    primary: "#59C2FF",
    accent: "#FFB454",
    error: "#D95757",
    warning: "#FF8F40",
    success: "#C2D94C",
    info: "#95E6CB",
    text: "#B3B1AD",
    muted: "#626A73",
    background: "#0A0E14",
    panel: "#0D1017",
    element: "#131721",
    highlight: "#1B212C",
    inverse: "#0A0E14",
    border: "#2D3640",
    borderActive: "#FFB454",
  },
  oxocarbon: {
    name: "oxocarbon",
    primary: "#78A9FF",
    accent: "#EE5396",
    error: "#FA4D56",
    warning: "#F1C21B",
    success: "#42BE65",
    info: "#3DDBD9",
    text: "#F2F4F8",
    muted: "#A8A8A8",
    background: "#161616",
    panel: "#262626",
    element: "#393939",
    highlight: "#525252",
    inverse: "#161616",
    border: "#6F6F6F",
    borderActive: "#78A9FF",
  },
  "night-owl": {
    name: "night-owl",
    primary: "#82AAFF",
    accent: "#C792EA",
    error: "#EF5350",
    warning: "#ECC48D",
    success: "#ADDB67",
    info: "#7FDBCA",
    text: "#D6DEEB",
    muted: "#637777",
    background: "#011627",
    panel: "#0B2942",
    element: "#1D3B53",
    highlight: "#1E4B6B",
    inverse: "#011627",
    border: "#5F7E97",
    borderActive: "#82AAFF",
  },
  terminal: {
    name: "terminal",
    primary: "#55FFFF",
    accent: "#FF55FF",
    error: "#FF5555",
    warning: "#FFFF55",
    success: "#55FF55",
    info: "#5555FF",
    text: "#C0C0C0",
    muted: "#808080",
    background: "#000000",
    panel: "#000000",
    element: "#000000",
    highlight: "#1A1A1A",
    inverse: "#000000",
    border: "#555555",
    borderActive: "#55FFFF",
  },
  system: {
    name: "system",
    primary: "#60A5FA",
    accent: "#C084FC",
    error: "#F87171",
    warning: "#FBBF24",
    success: "#34D399",
    info: "#22D3EE",
    text: "#F9FAFB",
    muted: "#C4CAD3",
    background: "#030712",
    panel: "#111827",
    element: "#1F2937",
    highlight: "#374151",
    inverse: "#030712",
    border: "#4B5563",
    borderActive: "#60A5FA",
  },
  devctl: {
    name: "devctl",
    primary: "#FFB020",
    accent: "#3DE0FF",
    error: "#FF5C7A",
    warning: "#FFD166",
    success: "#3DFF9A",
    info: "#3DE0FF",
    text: "#F7FAFD",
    muted: "#B7C3D0",
    background: "#070B10",
    panel: "#121A22",
    element: "#1C2833",
    highlight: "#243444",
    inverse: "#0A1016",
    border: "#334556",
    borderActive: "#FFB020",
  },
  ember: {
    name: "ember",
    primary: "#FF9F43",
    accent: "#2EE6FF",
    error: "#FF4D6D",
    warning: "#FFE566",
    success: "#3DFF9A",
    info: "#2EE6FF",
    text: "#F7F9FF",
    muted: "#B0B8CC",
    background: "#07090F",
    panel: "#12161F",
    element: "#1A2130",
    highlight: "#243044",
    inverse: "#0B0D12",
    border: "#334155",
    borderActive: "#FF9F43",
  },
};

const THEME_ALIASES: Record<string, ThemeName> = {
  opencode: "ember",
  light: "system",
  mocha: "catppuccin",
  latte: "catppuccin-latte",
  "one-dark": "onedark",
  "one dark": "onedark",
  solarized: "solarized-dark",
  rosepine: "rose-pine",
  "rose pine": "rose-pine",
  github: "github-dark",
  ayu: "ayu-dark",
  "night owl": "night-owl",
  ansi: "terminal",
  xterm: "terminal",
  console: "terminal",
  classic: "terminal",
  vga: "terminal",
};

export function resolveThemeName(name: string): ThemeName {
  const key = name.toLowerCase().trim();
  const aliased = THEME_ALIASES[key];
  if (aliased) {
    return aliased;
  }
  return THEME_NAMES.includes(key as ThemeName) ? (key as ThemeName) : "devctl";
}

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
  if (resolved === "system") {
    if (systemPrefersLight()) {
      return { ...PALETTES["solarized-light"], name: "system" };
    }
    return PALETTES.system;
  }
  return PALETTES[resolved];
}

export function themeBlurb(name: string): string {
  return THEME_BLURBS[resolveThemeName(name)];
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
const LUMINANCE_RED = 299;
const LUMINANCE_GREEN = 587;
const LUMINANCE_BLUE = 114;
const LUMINANCE_SCALE = 1000;
const LIGHT_BG_CUTOFF = 160;
const HEX_RADIX = 16;
const BYTE_MASK = 255;
const RED_SHIFT = 16;
const GREEN_SHIFT = 8;

export const CHIP_DARK_INK = "#1A1A1A";

export function chipForeground(background: string, fallback: string): string {
  return hexLuminance(background) >= LIGHT_BG_CUTOFF ? CHIP_DARK_INK : fallback;
}

export function hexLuminance(hex: string): number {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  const value = Number.parseInt(raw, HEX_RADIX);
  if (Number.isNaN(value)) {
    return 0;
  }
  const red = (value >> RED_SHIFT) & BYTE_MASK;
  const green = (value >> GREEN_SHIFT) & BYTE_MASK;
  const blue = value & BYTE_MASK;
  return (red * LUMINANCE_RED + green * LUMINANCE_GREEN + blue * LUMINANCE_BLUE) / LUMINANCE_SCALE;
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

export function isLightPalette(palette: Palette): boolean {
  return hexLuminance(palette.background) >= LIGHT_BG_CUTOFF;
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

export function logSpanColor(palette: Palette, level: string, kind: "text" | "string" | "keyword" | "number"): string {
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
