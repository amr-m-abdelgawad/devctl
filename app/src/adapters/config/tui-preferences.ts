import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homeDir, writeFileSecure } from "../storage/storage.ts";
import { repoID } from "../../shared/repo-id.ts";
import {
  defaultTuiConfig,
  isWebAppearance,
  preferenceResetPatch,
  TUI_CONFIG_ENV,
  type CursorStyle,
  type PreferenceLayer,
  type PreferenceScope,
  type PreferenceSnapshot,
  type SaveTuiPreferencesOpts,
  type TuiAttentionSounds,
  type TuiConfig,
  type TuiKeybinds,
  type TuiPreferencePatch,
} from "../../domain/ui/preferences.ts";
export * from "../../domain/ui/preferences.ts";
const LEGACY_TUI_CONFIG_ENV = "OPENCODE_TUI_CONFIG";
const TEAM_TUI_NAMES = ["tui.json", "tui.jsonc"];
const PROVENANCE_KEYS = [
  "theme",
  "font_size",
  "mouse",
  "leader_timeout",
  "scroll_speed",
  "log_timestamps",
  "log_metadata",
  "web_appearance",
  "mcp_enabled",
  "mcp_port",
] as const;

export function userTuiConfigPath(): string {
  return join(homeDir(), "tui.json");
}

export function repoTuiConfigPath(repoRoot: string): string {
  return join(homeDir(), "state", repoID(repoRoot), "tui.json");
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
// below every tui.json layer (env override, team file, user-home, per-repo
// overlay) so any of those can still override a specific binding, but it
// still overrides the hardcoded DEFAULT_KEYBINDS for anyone who hasn't set
// their own.
function applyYamlKeymap(base: TuiConfig, yamlKeymap?: TuiKeybinds): TuiConfig {
  if (!yamlKeymap || Object.keys(yamlKeymap).length === 0) {
    return base;
  }
  return { ...base, keybinds: { ...base.keybinds, ...yamlKeymap } };
}

function readJsoncFile(path: string): unknown {
  return parseJsonc(readFileSync(path, "utf8"));
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((path) => existsSync(path));
}

export function teamTuiConfigPath(startDir: string): string | undefined {
  const root = startDir || process.cwd();
  const candidates: string[] = [];
  for (const dir of [root, join(root, ".devctl")]) {
    for (const name of TEAM_TUI_NAMES) {
      candidates.push(join(dir, name));
    }
  }
  return firstExisting(candidates);
}

export function loadTuiConfig(startDir: string, yamlKeymap?: TuiKeybinds): TuiConfig {
  const cfg = applyYamlKeymap(defaultTuiConfig(), yamlKeymap);
  const overridePath = resolveTuiOverridePath(startDir);
  if (overridePath) {
    return mergeTuiConfig(cfg, readJsoncFile(overridePath), overridePath);
  }
  let next = cfg;
  let path: string | undefined;
  const teamPath = teamTuiConfigPath(startDir);
  if (teamPath) {
    next = mergeTuiConfig(next, readJsoncFile(teamPath), teamPath);
    path = teamPath;
  }
  const userPath = userTuiConfigPath();
  if (existsSync(userPath) && userPath !== teamPath) {
    next = mergeTuiConfig(next, readJsoncFile(userPath), userPath);
    path = userPath;
  }
  const repoPath = repoTuiConfigPath(startDir);
  if (existsSync(repoPath) && repoPath !== userPath && repoPath !== teamPath) {
    next = mergeTuiConfig(next, readJsoncFile(repoPath), repoPath);
    path = repoPath;
  }
  return path === undefined ? next : { ...next, path };
}

function preferenceSavePath(opts?: SaveTuiPreferencesOpts): string {
  if (opts?.scope === "repo" && opts.repoRoot && opts.repoRoot !== "") {
    return repoTuiConfigPath(opts.repoRoot);
  }
  return userTuiConfigPath();
}

function repoSavePath(opts?: SaveTuiPreferencesOpts): string {
  if (opts?.repoRoot && opts.repoRoot !== "") {
    return repoTuiConfigPath(opts.repoRoot);
  }
  return preferenceSavePath(opts);
}

function takeMcpPatch(partial: TuiPreferencePatch): { mcp: TuiPreferencePatch; rest: TuiPreferencePatch } {
  const mcp: TuiPreferencePatch = {};
  const rest: TuiPreferencePatch = { ...partial };
  if (partial.mcp_enabled !== undefined) {
    mcp.mcp_enabled = partial.mcp_enabled;
  }
  if (partial.mcp_port !== undefined) {
    mcp.mcp_port = partial.mcp_port;
  }
  if (partial.mcp_disabled_tools !== undefined) {
    mcp.mcp_disabled_tools = partial.mcp_disabled_tools;
  }
  if (partial.mcp_enabled_tools !== undefined) {
    mcp.mcp_enabled_tools = partial.mcp_enabled_tools;
  }
  delete rest.mcp_enabled;
  delete rest.mcp_port;
  delete rest.mcp_disabled_tools;
  delete rest.mcp_enabled_tools;
  return { mcp, rest };
}

function readRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readJsoncFile(path);
  return isRecord(raw) ? raw : {};
}

function applyPatchRecord(existing: Record<string, unknown>, partial: TuiPreferencePatch): Record<string, unknown> {
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
  if (partial.scroll_speed !== undefined) {
    next.scroll_speed = partial.scroll_speed;
  }
  if (partial.log_timestamps !== undefined) {
    next.log_timestamps = partial.log_timestamps;
  }
  if (partial.log_metadata !== undefined) {
    next.log_metadata = partial.log_metadata;
  }
  if (partial.web_appearance !== undefined) {
    next.web_appearance = partial.web_appearance;
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
  if (partial.mcp_enabled_tools !== undefined) {
    next.mcp_enabled_tools = partial.mcp_enabled_tools;
  }
  if (partial.dismissed_notifications !== undefined) {
    next.dismissed_notifications = partial.dismissed_notifications;
  }
  return next;
}

function writePreferenceFile(path: string, partial: TuiPreferencePatch): string {
  const next = applyPatchRecord(readRecord(path), partial);
  writeFileSecure(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

function patchHasFields(partial: TuiPreferencePatch, includeDismissed: boolean): boolean {
  const keys = Object.entries(partial).filter(([key, value]) => {
    if (value === undefined) {
      return false;
    }
    return includeDismissed || key !== "dismissed_notifications";
  });
  return keys.length > 0;
}

export function saveTuiPreferences(partial: TuiPreferencePatch, opts?: SaveTuiPreferencesOpts): string {
  const dismissed = partial.dismissed_notifications;
  const split = takeMcpPatch(partial);
  delete split.rest.dismissed_notifications;
  let dest = preferenceSavePath(opts);
  if (patchHasFields(split.mcp, false)) {
    dest = writePreferenceFile(repoSavePath(opts), split.mcp);
  }
  if (patchHasFields(split.rest, false)) {
    dest = writePreferenceFile(preferenceSavePath(opts), split.rest);
  }
  if (dismissed !== undefined) {
    writePreferenceFile(userTuiConfigPath(), { dismissed_notifications: dismissed });
    if (!patchHasFields(split.mcp, false) && !patchHasFields(split.rest, false)) {
      dest = userTuiConfigPath();
    }
  }
  return dest;
}

export function resetTuiPreferences(opts?: SaveTuiPreferencesOpts): string {
  return saveTuiPreferences(preferenceResetPatch(), opts);
}

function layerForKey(key: string, files: { override?: Record<string, unknown>; repo?: Record<string, unknown>; user?: Record<string, unknown>; team?: Record<string, unknown> }, locked: boolean): PreferenceLayer {
  if (files.override && files.override[key] !== undefined) {
    return "override";
  }
  if (locked) {
    return "default";
  }
  if (files.repo && files.repo[key] !== undefined) {
    return "repo";
  }
  if (files.user && files.user[key] !== undefined) {
    return "user";
  }
  if (files.team && files.team[key] !== undefined) {
    return "team";
  }
  return "default";
}

export function repoLocalConfigPath(repoRoot: string): string {
  return join(repoRoot, ".devctl", "config.local.yaml");
}

export function getPreferenceSnapshot(
  repoRoot: string,
  opts?: {
    yamlKeymap?: TuiKeybinds;
    scope?: PreferenceScope;
    webEnabled?: boolean;
    webPort?: number;
  },
): PreferenceSnapshot {
  const loaded = loadTuiConfig(repoRoot, opts?.yamlKeymap);
  const overridePath = resolveTuiOverridePath(repoRoot);
  const teamPath = teamTuiConfigPath(repoRoot);
  const userPath = userTuiConfigPath();
  const repoPath = repoTuiConfigPath(repoRoot);
  const locked = overridePath !== undefined;
  const scope = opts?.scope ?? "repo";
  const files = {
    override: overridePath ? readRecord(overridePath) : undefined,
    repo: existsSync(repoPath) ? readRecord(repoPath) : undefined,
    user: existsSync(userPath) ? readRecord(userPath) : undefined,
    team: teamPath ? readRecord(teamPath) : undefined,
  };
  const layers: Record<string, PreferenceLayer> = {};
  for (const key of PROVENANCE_KEYS) {
    layers[key] = layerForKey(key, files, locked);
  }
  const write = locked ? overridePath : scope === "repo" ? repoPath : userPath;
  return {
    values: {
      theme: loaded.theme,
      font_size: loaded.font_size,
      mouse: loaded.mouse,
      leader_timeout: loaded.leader_timeout,
      scroll_speed: loaded.scroll_speed,
      log_timestamps: loaded.log_timestamps,
      log_metadata: loaded.log_metadata,
      web_appearance: loaded.web_appearance,
      mcp_enabled: loaded.mcp_enabled,
      mcp_port: loaded.mcp_port,
    },
    scope,
    locked,
    paths: {
      user: userPath,
      repo: repoPath,
      write,
      team: teamPath,
      override: overridePath,
      local: repoLocalConfigPath(repoRoot),
    },
    layers,
    local: {
      web_enabled: opts?.webEnabled === true,
      web_port: opts?.webPort ?? 0,
    },
  };
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
    web_appearance: isWebAppearance(rec.web_appearance) ? rec.web_appearance : base.web_appearance,
    mcp_enabled: typeof rec.mcp_enabled === "boolean" ? rec.mcp_enabled : base.mcp_enabled,
    mcp_port: typeof rec.mcp_port === "number" && Number.isInteger(rec.mcp_port) ? rec.mcp_port : base.mcp_port,
    mcp_disabled_tools: Array.isArray(rec.mcp_disabled_tools)
      ? rec.mcp_disabled_tools.filter((name): name is string => typeof name === "string")
      : base.mcp_disabled_tools,
    mcp_enabled_tools: Array.isArray(rec.mcp_enabled_tools)
      ? rec.mcp_enabled_tools.filter((name): name is string => typeof name === "string")
      : base.mcp_enabled_tools,
    dismissed_notifications: Array.isArray(rec.dismissed_notifications)
      ? rec.dismissed_notifications.filter((id): id is string => typeof id === "string" && id !== "")
      : base.dismissed_notifications,
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

