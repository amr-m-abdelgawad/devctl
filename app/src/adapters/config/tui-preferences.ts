import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homeDir, writeFileSecure } from "../storage/storage.ts";
import { defaultTuiConfig, TUI_CONFIG_ENV, type TuiConfig, type TuiKeybinds, type TuiPreferencePatch, type TuiAttentionSounds, type CursorStyle } from "../../domain/ui/preferences.ts";
export * from "../../domain/ui/preferences.ts";
const LEGACY_TUI_CONFIG_ENV = "OPENCODE_TUI_CONFIG";

export function userTuiConfigPath(): string {
  return join(homeDir(), "tui.json");
}

export function resolveTuiOverridePath(startDir = ""): string | undefined {
  for (const key of [TUI_CONFIG_ENV, LEGACY_TUI_CONFIG_ENV]) {
    const override = process.env[key];
    if (!override || override === "") {
      continue;
    }
    const abs = isAbsolute(override) ? override : resolve(startDir || process.cwd(), override);
    if (existsSync(abs)) {
      return abs;
    }
  }
  return undefined;
}

// config.yaml's ui.keymap is a project-wide, checked-in default — applied
// below every tui.json layer (env override, repo-local, user-home) so any
// of those can still override a specific binding, but it still overrides
// the hardcoded DEFAULT_KEYBINDS for anyone who hasn't set their own.
function applyYamlKeymap(base: TuiConfig, yamlKeymap?: TuiKeybinds): TuiConfig {
  if (!yamlKeymap || Object.keys(yamlKeymap).length === 0) {
    return base;
  }
  return { ...base, keybinds: { ...base.keybinds, ...yamlKeymap } };
}

export function loadTuiConfig(startDir: string, yamlKeymap?: TuiKeybinds): TuiConfig {
  const cfg = applyYamlKeymap(defaultTuiConfig(), yamlKeymap);
  const overridePath = resolveTuiOverridePath(startDir);
  if (overridePath) {
    return mergeTuiConfig(cfg, parseJsonc(readFileSync(overridePath, "utf8")), overridePath);
  }
  const path = resolveTuiConfigPath(startDir);
  const fromFile = path ? mergeTuiConfig(cfg, parseJsonc(readFileSync(path, "utf8")), path) : cfg;
  const userPath = userTuiConfigPath();
  if (!existsSync(userPath) || path === userPath) {
    return fromFile;
  }
  return mergeTuiConfig(fromFile, parseJsonc(readFileSync(userPath, "utf8")), userPath);
}

export function saveTuiPreferences(partial: TuiPreferencePatch): string {
  const path = userTuiConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = parseJsonc(readFileSync(path, "utf8"));
    if (isRecord(raw)) {
      existing = raw;
    }
  }
  const next: Record<string, unknown> = { ...existing };
  if (partial.theme !== undefined) {
    next.theme = partial.theme;
  }
  if (partial.mouse !== undefined) {
    next.mouse = partial.mouse;
  }
  if (partial.leader_timeout !== undefined) {
    next.leader_timeout = partial.leader_timeout;
  }
  if (partial.font_size !== undefined) {
    next.font_size = partial.font_size;
  }
  if (partial.log_timestamps !== undefined) {
    next.log_timestamps = partial.log_timestamps;
  }
  if (partial.log_metadata !== undefined) {
    next.log_metadata = partial.log_metadata;
  }
  if (partial.mcp_enabled !== undefined) {
    next.mcp_enabled = partial.mcp_enabled;
  }
  if (partial.mcp_port === null) {
    delete next.mcp_port;
  } else if (partial.mcp_port !== undefined) {
    next.mcp_port = partial.mcp_port;
  }
  if (partial.mcp_disabled_tools !== undefined) {
    // Written even when empty: an explicit [] is how "I turned everything
    // back on" is distinguished from "I never touched this".
    next.mcp_disabled_tools = partial.mcp_disabled_tools;
  }
  writeFileSecure(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

export function resolveTuiConfigPath(startDir: string): string | undefined {
  const override = resolveTuiOverridePath(startDir);
  if (override) {
    return override;
  }
  const roots = [
    startDir || process.cwd(),
    join(startDir || process.cwd(), ".devctl"),
    homeDir(),
  ];
  const names = ["tui.json", "tui.jsonc"];
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function mergeTuiConfig(base: TuiConfig, raw: unknown, path: string): TuiConfig {
  const rec = isRecord(raw) ? raw : {};
  const keybinds = { ...base.keybinds };
  if (isRecord(rec.keybinds)) {
    for (const [key, value] of Object.entries(rec.keybinds)) {
      if (typeof value === "string") {
        keybinds[key] = value;
      }
    }
  }
  const cursor = { ...base.cursor };
  if (isRecord(rec.cursor)) {
    if (isCursorStyle(rec.cursor.style)) {
      cursor.style = rec.cursor.style;
    }
    if (typeof rec.cursor.blinking === "boolean") {
      cursor.blinking = rec.cursor.blinking;
    }
  }
  const scrollAcceleration = { ...base.scroll_acceleration };
  if (isRecord(rec.scroll_acceleration) && typeof rec.scroll_acceleration.enabled === "boolean") {
    scrollAcceleration.enabled = rec.scroll_acceleration.enabled;
  }
  const attention = { ...base.attention, sounds: { ...base.attention.sounds } };
  if (isRecord(rec.attention)) {
    if (typeof rec.attention.enabled === "boolean") {
      attention.enabled = rec.attention.enabled;
    }
    if (typeof rec.attention.notifications === "boolean") {
      attention.notifications = rec.attention.notifications;
    }
    if (typeof rec.attention.sound === "boolean") {
      attention.sound = rec.attention.sound;
    }
    if (typeof rec.attention.volume === "number") {
      attention.volume = rec.attention.volume;
    }
    if (typeof rec.attention.sound_pack === "string") {
      attention.sound_pack = rec.attention.sound_pack;
    }
    if (isRecord(rec.attention.sounds)) {
      for (const [key, value] of Object.entries(rec.attention.sounds)) {
        if (typeof value === "string") {
          attention.sounds[key as keyof TuiAttentionSounds] = resolveSoundPath(value, path);
        }
      }
    }
  }
  return {
    theme: typeof rec.theme === "string" ? rec.theme : base.theme,
    leader_timeout: typeof rec.leader_timeout === "number" ? rec.leader_timeout : base.leader_timeout,
    font_size: typeof rec.font_size === "number" && Number.isFinite(rec.font_size) ? Math.round(rec.font_size) : base.font_size,
    keybinds,
    scroll_speed: typeof rec.scroll_speed === "number" ? rec.scroll_speed : base.scroll_speed,
    scroll_acceleration: scrollAcceleration,
    diff_style: rec.diff_style === "stacked" ? "stacked" : "auto",
    cursor,
    mouse: typeof rec.mouse === "boolean" ? rec.mouse : base.mouse,
    attention,
    log_timestamps: typeof rec.log_timestamps === "boolean" ? rec.log_timestamps : base.log_timestamps,
    log_metadata: typeof rec.log_metadata === "boolean" ? rec.log_metadata : base.log_metadata,
    mcp_enabled: typeof rec.mcp_enabled === "boolean" ? rec.mcp_enabled : base.mcp_enabled,
    mcp_port: typeof rec.mcp_port === "number" && Number.isInteger(rec.mcp_port) ? rec.mcp_port : base.mcp_port,
    mcp_disabled_tools: Array.isArray(rec.mcp_disabled_tools)
      ? rec.mcp_disabled_tools.filter((name): name is string => typeof name === "string")
      : base.mcp_disabled_tools,
    path,
  };
}

function resolveSoundPath(value: string, configPath: string): string {
  if (value.startsWith("file://") || isAbsolute(value)) {
    return value;
  }
  return join(dirname(configPath), value);
}

function isCursorStyle(value: unknown): value is CursorStyle {
  return value === "block" || value === "underline" || value === "line" || value === "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped) as unknown;
}

