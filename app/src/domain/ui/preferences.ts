export const DEFAULT_LEADER_TIMEOUT_MS = 2000;
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_SCROLL_SPEED = 3;
export const DEFAULT_ATTENTION_VOLUME = 0.4;
export const TUI_CONFIG_ENV = "DEVCTL_TUI_CONFIG";
export const SCROLL_SPEEDS = [1, 2, 3, 4, 5, 6] as const;
export type WebAppearance = "dark" | "light";
export const DEFAULT_WEB_APPEARANCE: WebAppearance = "dark";
export type PreferenceScope = "user" | "repo";
export type PreferenceLayer = "default" | "team" | "user" | "repo" | "override";

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
  web_appearance: WebAppearance;
  mcp_enabled: boolean;
  mcp_port?: number;
  // Deny-list: names of MCP tools turned off. Combined at boot with
  // DEFAULT_DISABLED_MCP_TOOLS unless those names appear in mcp_enabled_tools.
  mcp_disabled_tools?: string[];
  // Opt-in list for tools that are off by default (currently exec_service).
  mcp_enabled_tools?: string[];
  /** Notification ids the operator dismissed (for example `update:0.10.0`). */
  dismissed_notifications?: string[];
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

/** Tools that stay off until the operator opts in via `mcp_enabled_tools`. */
export const DEFAULT_DISABLED_MCP_TOOLS = ["exec_service"] as const;

export function effectiveMcpDisabledTools(
  savedDisabled: readonly string[] | undefined,
  savedEnabled: readonly string[] | undefined,
): string[] {
  const enabled = new Set(savedEnabled ?? []);
  const seeded = DEFAULT_DISABLED_MCP_TOOLS.filter((name) => !enabled.has(name));
  return [...new Set([...(savedDisabled ?? []), ...seeded])].sort();
}

export function mcpToolPreferenceLists(disabled: readonly string[]): {
  mcp_disabled_tools: string[];
  mcp_enabled_tools: string[];
} {
  const off = new Set(disabled);
  return {
    mcp_disabled_tools: disabled.filter((name) => !isDefaultDisabledMcpTool(name)),
    mcp_enabled_tools: DEFAULT_DISABLED_MCP_TOOLS.filter((name) => !off.has(name)),
  };
}

function isDefaultDisabledMcpTool(name: string): boolean {
  return (DEFAULT_DISABLED_MCP_TOOLS as readonly string[]).includes(name);
}

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
    web_appearance: DEFAULT_WEB_APPEARANCE,
    mcp_enabled: false,
  };
}

export type TuiPreferencePatch = {
  theme?: string;
  mouse?: boolean;
  leader_timeout?: number;
  font_size?: number;
  scroll_speed?: number;
  log_timestamps?: boolean;
  log_metadata?: boolean;
  web_appearance?: WebAppearance;
  mcp_enabled?: boolean;
  mcp_port?: number | null;
  mcp_disabled_tools?: string[];
  mcp_enabled_tools?: string[];
  dismissed_notifications?: string[];
};

export type SaveTuiPreferencesOpts = {
  repoRoot?: string;
  scope?: PreferenceScope;
};

export type LocalWebPatch = {
  web_enabled?: boolean;
  web_port?: number;
  inspect_max_bytes?: number;
};

export type PreferenceWrite = TuiPreferencePatch & {
  scope?: PreferenceScope;
  reset?: boolean;
  local?: LocalWebPatch;
};

export function isPreferenceScope(value: unknown): value is PreferenceScope {
  return value === "user" || value === "repo";
}

export function preferenceResetPatch(): TuiPreferencePatch {
  return {
    theme: "devctl",
    mouse: true,
    leader_timeout: DEFAULT_LEADER_TIMEOUT_MS,
    font_size: DEFAULT_FONT_SIZE,
    scroll_speed: DEFAULT_SCROLL_SPEED,
    log_timestamps: true,
    log_metadata: true,
    web_appearance: DEFAULT_WEB_APPEARANCE,
  };
}

export function parsePreferenceWrite(args: Record<string, unknown>): PreferenceWrite {
  const out: PreferenceWrite = {};
  if (isPreferenceScope(args.scope)) {
    out.scope = args.scope;
  }
  if (args.reset === true) {
    out.reset = true;
  }
  if (typeof args.theme === "string") {
    out.theme = args.theme;
  }
  if (typeof args.font_size === "number" && Number.isFinite(args.font_size)) {
    out.font_size = Math.round(args.font_size);
  }
  if (typeof args.mouse === "boolean") {
    out.mouse = args.mouse;
  }
  if (typeof args.leader_timeout === "number" && Number.isFinite(args.leader_timeout)) {
    out.leader_timeout = args.leader_timeout;
  }
  if (typeof args.scroll_speed === "number" && Number.isFinite(args.scroll_speed)) {
    out.scroll_speed = args.scroll_speed;
  }
  if (typeof args.log_timestamps === "boolean") {
    out.log_timestamps = args.log_timestamps;
  }
  if (typeof args.log_metadata === "boolean") {
    out.log_metadata = args.log_metadata;
  }
  if (isWebAppearance(args.web_appearance)) {
    out.web_appearance = args.web_appearance;
  }
  if (typeof args.mcp_enabled === "boolean") {
    out.mcp_enabled = args.mcp_enabled;
  }
  if (args.mcp_port === null) {
    out.mcp_port = null;
  } else if (typeof args.mcp_port === "number" && Number.isInteger(args.mcp_port)) {
    out.mcp_port = args.mcp_port;
  }
  if (Array.isArray(args.mcp_disabled_tools)) {
    out.mcp_disabled_tools = args.mcp_disabled_tools.filter((name): name is string => typeof name === "string");
  }
  if (Array.isArray(args.mcp_enabled_tools)) {
    out.mcp_enabled_tools = args.mcp_enabled_tools.filter((name): name is string => typeof name === "string");
  }
  if (isPlainRecord(args.local)) {
    const local: LocalWebPatch = {};
    if (typeof args.local.web_enabled === "boolean") {
      local.web_enabled = args.local.web_enabled;
    }
    if (typeof args.local.web_port === "number" && Number.isInteger(args.local.web_port)) {
      local.web_port = args.local.web_port;
    }
    if (typeof args.local.inspect_max_bytes === "number" && Number.isInteger(args.local.inspect_max_bytes)) {
      local.inspect_max_bytes = args.local.inspect_max_bytes;
    }
    if (local.web_enabled !== undefined || local.web_port !== undefined || local.inspect_max_bytes !== undefined) {
      out.local = local;
    }
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type PreferenceValues = {
  theme: string;
  font_size: number;
  mouse: boolean;
  leader_timeout: number;
  scroll_speed: number;
  log_timestamps: boolean;
  log_metadata: boolean;
  web_appearance: WebAppearance;
  mcp_enabled: boolean;
  mcp_port?: number;
};

export type PreferenceSnapshot = {
  values: PreferenceValues;
  scope: PreferenceScope;
  locked: boolean;
  paths: {
    user: string;
    repo: string;
    write: string;
    team?: string;
    override?: string;
    local: string;
  };
  layers: Record<string, PreferenceLayer>;
  local: {
    web_enabled: boolean;
    web_port: number;
    inspect_max_bytes: number;
  };
};

export function isWebAppearance(value: unknown): value is WebAppearance {
  return value === "dark" || value === "light";
}

export function nearestScrollSpeed(current: number): number {
  const steps = [...SCROLL_SPEEDS];
  return steps.reduce((best, step) => (Math.abs(step - current) < Math.abs(best - current) ? step : best), steps[0]!);
}

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
