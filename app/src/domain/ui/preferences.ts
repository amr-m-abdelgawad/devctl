export const DEFAULT_LEADER_TIMEOUT_MS = 2000;
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_SCROLL_SPEED = 3;
export const DEFAULT_ATTENTION_VOLUME = 0.4;
export const TUI_CONFIG_ENV = "DEVCTL_TUI_CONFIG";

export type CursorStyle = "block" | "underline" | "line" | "default";
export type DiffStyle = "auto" | "stacked";

export type TuiCursorConfig = {
  style: CursorStyle;
  blinking: boolean;
};

export type TuiScrollAcceleration = {
  enabled: boolean;
};

export type TuiAttentionSounds = {
  default?: string;
  question?: string;
  permission?: string;
  error?: string;
  done?: string;
  subagent_done?: string;
};

export type TuiAttentionConfig = {
  enabled: boolean;
  notifications: boolean;
  sound: boolean;
  volume: number;
  sound_pack: string;
  sounds: TuiAttentionSounds;
};

export type TuiKeybinds = Record<string, string>;

export type TuiConfig = {
  theme: string;
  leader_timeout: number;
  font_size: number;
  keybinds: TuiKeybinds;
  scroll_speed: number;
  scroll_acceleration: TuiScrollAcceleration;
  diff_style: DiffStyle;
  cursor: TuiCursorConfig;
  mouse: boolean;
  attention: TuiAttentionConfig;
  log_timestamps: boolean;
  log_metadata: boolean;
  mcp_enabled: boolean;
  mcp_port?: number;
  // Deny-list: names of MCP tools turned off. Absent or empty means every
  // tool is available, so a tool added in a later version is on by default.
  mcp_disabled_tools?: string[];
  path?: string;
};

export function isApplePlatform(platform = process.platform): boolean {
  return platform === "darwin";
}

/** Primary chord modifier: Command on macOS, Control everywhere else. */
export function primaryMod(platform = process.platform): "cmd" | "ctrl" {
  return isApplePlatform(platform) ? "cmd" : "ctrl";
}

export function withMod(key: string, platform = process.platform): string {
  return `${primaryMod(platform)}+${key}`;
}

/** Human label for the primary modifier: "command" on macOS, "ctrl" elsewhere. */
export function displayMod(platform = process.platform): "command" | "ctrl" {
  return isApplePlatform(platform) ? "command" : "ctrl";
}

export function displayWithMod(key: string, platform = process.platform): string {
  return `${displayMod(platform)}+${key}`;
}

/** Expand `cmd` to `command` in a stored keybind so the TUI matches the OS wording. */
export function displayKeybind(spec: string): string {
  return spec.replace(/\bcmd\b/gi, "command");
}

export function hasPrimaryMod(
  event: { ctrl?: boolean; meta?: boolean; super?: boolean },
  platform = process.platform,
): boolean {
  const apple = isApplePlatform(platform);
  const cmd = Boolean(event.meta || event.super);
  const ctrl = Boolean(event.ctrl);
  return apple ? cmd && !ctrl : ctrl && !cmd;
}

export function defaultCopyKeybind(platform = process.platform): string {
  return withMod("c", platform);
}

export function defaultKeybinds(platform = process.platform): TuiKeybinds {
  return {
    leader: withMod("x", platform),
    command_list: withMod("p", platform),
    command: "/",
    help: "?",
    search: "f",
    quit: "q",
    services: "s",
    logs: "l",
    auth: "a",
    proxy: "p",
    doctor: "d",
    config: "c",
    setup: "u",
    refresh: "r",
    restart: "R",
    find: "f",
    fullscreen: "z",
    confirm: "enter",
    cancel: "esc",
    select: "space",
    interrupt: "escape",
    copy: defaultCopyKeybind(platform),
  };
}

export const DEFAULT_KEYBINDS: TuiKeybinds = defaultKeybinds();

export function defaultTuiConfig(): TuiConfig {
  return {
    theme: "devctl",
    leader_timeout: DEFAULT_LEADER_TIMEOUT_MS,
    font_size: DEFAULT_FONT_SIZE,
    keybinds: { ...DEFAULT_KEYBINDS },
    scroll_speed: DEFAULT_SCROLL_SPEED,
    scroll_acceleration: { enabled: false },
    diff_style: "auto",
    cursor: { style: "block", blinking: true },
    mouse: true,
    attention: {
      enabled: false,
      notifications: true,
      sound: true,
      volume: DEFAULT_ATTENTION_VOLUME,
      sound_pack: "default",
      sounds: {},
    },
    log_timestamps: true,
    log_metadata: true,
    mcp_enabled: false,
  };
}

export type TuiPreferencePatch = {
  theme?: string;
  mouse?: boolean;
  leader_timeout?: number;
  font_size?: number;
  log_timestamps?: boolean;
  log_metadata?: boolean;
  mcp_enabled?: boolean;
  mcp_port?: number | null;
  mcp_disabled_tools?: string[];
};

export type ParsedKey = {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  alt: boolean;
};

export function parseKeybind(spec: string): ParsedKey[] {
  if (spec === "" || spec === "none") {
    return [];
  }
  return spec.split(",").flatMap((part) => {
    const trimmed = part.trim();
    if (trimmed === "" || trimmed === "none" || /\s/.test(trimmed)) {
      return [];
    }
    const tokens = trimmed.toLowerCase().split("+");
    const key = tokens[tokens.length - 1] ?? "";
    return [
      {
        name: key === "return" ? "return" : key,
        ctrl: tokens.includes("ctrl") || tokens.includes("control"),
        shift: tokens.includes("shift"),
        meta: tokens.includes("meta") || tokens.includes("cmd") || tokens.includes("super"),
        alt: tokens.includes("alt") || tokens.includes("option"),
      },
    ];
  });
}

export function keyMatches(
  event: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; option?: boolean; alt?: boolean; super?: boolean },
  spec: string,
): boolean {
  const parsed = parseKeybind(spec);
  return parsed.some(
    (key) =>
      (event.name ?? "").toLowerCase() === key.name &&
      Boolean(event.ctrl) === key.ctrl &&
      Boolean(event.shift) === key.shift &&
      Boolean(event.meta || event.super) === key.meta &&
      Boolean(event.option ?? event.alt) === key.alt,
  );
}
