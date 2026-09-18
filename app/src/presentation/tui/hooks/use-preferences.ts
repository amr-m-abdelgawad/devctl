import { RGBA } from "@opentui/core";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import { DEFAULT_WEB_PORT } from "../../../domain/config/types.ts";
import { clampMcpPort } from "../../../domain/net/mcp-port.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import {
  cycleFontSize,
  cycleLeader,
  cyclePreferenceScope,
  cycleScrollSpeed,
  cycleTheme,
  cycleWebAppearance,
  formatFontSize,
  formatScope,
  nearestFontSize,
  prefsSavePath,
  selectedSettingsItem,
  settingsDefaults,
  settingsItems,
  tuiPrefsLocked,
  type SettingsItem,
} from "../settings.ts";
import { isDarkTerminalBackground, paletteFor, resolveThemeName, THEME_NAMES } from "../themes.ts";
import {
  nearestScrollSpeed,
  type LocalWebPatch,
  type PreferenceScope,
  type SaveTuiPreferencesOpts,
  type TuiConfig,
  type TuiPreferencePatch,
  type WebAppearance,
} from "../tui-config.ts";
import { type ConfirmKind, type Overlay, type Screen } from "../types.ts";

type Options = {
  tui: TuiConfig;
  controller: Controller | undefined;
  resolveTuiOverridePath: (startDir?: string | undefined) => string | undefined;
  terminalBackground: string | null | undefined;
  userTuiConfigPath: () => string;
  repoTuiConfigPath: (repoRoot: string) => string;
  patchRepoLocalConfig: (repoRoot: string, patch: LocalWebPatch) => string;
  snap: StatusSnapshot | undefined;
  setStatus: Dispatch<SetStateAction<string>>;
  saveTuiPreferences: (partial: TuiPreferencePatch, opts?: SaveTuiPreferencesOpts) => string;
  setPaletteIndex: Dispatch<SetStateAction<number>>;
  setOverlay: Dispatch<SetStateAction<Overlay>>;
  setConfirmKind: Dispatch<SetStateAction<ConfirmKind>>;
  setScreen: Dispatch<SetStateAction<Screen>>;
  setSelected: Dispatch<SetStateAction<number>>;
  setLogShowTimestamps?: (value: boolean) => void;
  setLogShowMeta?: (value: boolean) => void;
  screen: Screen;
};

export function usePreferences({
  tui,
  controller,
  resolveTuiOverridePath,
  terminalBackground,
  userTuiConfigPath,
  repoTuiConfigPath,
  patchRepoLocalConfig,
  snap,
  setStatus,
  saveTuiPreferences,
  setPaletteIndex,
  setOverlay,
  setConfirmKind,
  setScreen,
  setSelected,
  setLogShowTimestamps,
  setLogShowMeta,
  screen,
}: Options) {
  const repoRoot = controller?.cfg.repoRoot ?? "";
  const [scope, setScope] = useState<PreferenceScope>("repo");
  const [themeName, setThemeName] = useState(tui.theme || controller?.cfg.ui.theme || "devctl");
  const committedTheme = useRef(themeName);
  const [mousePref, setMousePref] = useState(tui.mouse);
  const committedMouse = useRef(tui.mouse);
  const [leaderMs, setLeaderMs] = useState(tui.leader_timeout);
  const committedLeader = useRef(tui.leader_timeout);
  const [fontSize, setFontSize] = useState(() => nearestFontSize(tui.font_size));
  const committedFont = useRef(fontSize);
  const [scrollSpeed, setScrollSpeed] = useState(() => nearestScrollSpeed(tui.scroll_speed));
  const committedScroll = useRef(scrollSpeed);
  const [logTimestamps, setLogTimestamps] = useState(tui.log_timestamps !== false);
  const committedTimestamps = useRef(logTimestamps);
  const [logMetadata, setLogMetadata] = useState(tui.log_metadata !== false);
  const committedMetadata = useRef(logMetadata);
  const [webAppearance, setWebAppearance] = useState<WebAppearance>(tui.web_appearance);
  const committedAppearance = useRef(webAppearance);
  const [webEnabled, setWebEnabled] = useState(controller?.cfg.web.enabled === true);
  const [webPort, setWebPort] = useState(() => controller?.cfg.web.listen.port || DEFAULT_WEB_PORT);
  const committedWebPort = useRef(webPort);
  const prefsLocked = tuiPrefsLocked(resolveTuiOverridePath());
  const userPath = userTuiConfigPath();
  const repoPath = repoTuiConfigPath(repoRoot || process.cwd());
  const localPath = repoRoot ? `${repoRoot.replace(/\/$/, "")}/.devctl/config.local.yaml` : ".devctl/config.local.yaml";
  const writePath = prefsLocked
    ? tui.path || prefsSavePath(resolveTuiOverridePath(), userPath)
    : scope === "repo"
      ? repoPath
      : userPath;
  const palette = useMemo(() => {
    const base = paletteFor(themeName);
    if (resolveThemeName(themeName) !== "terminal" || !isDarkTerminalBackground(terminalBackground)) {
      return base;
    }
    const native = terminalBackground ?? base.background;
    return {
      ...base,
      background: native,
      panel: native,
      element: native,
      inverse: native,
    };
  }, [terminalBackground, themeName]);
  const rootBackground =
    resolveThemeName(themeName) === "terminal" && isDarkTerminalBackground(terminalBackground)
      ? RGBA.defaultBackground(terminalBackground ?? undefined)
      : palette.background;
  const settingRows = useMemo(
    () =>
      settingsItems({
        themeName,
        fontSize,
        mouse: mousePref,
        leaderMs,
        locked: prefsLocked,
        configPath: writePath,
        mcpRunning: snap?.mcp?.running === true,
        scope,
        scrollSpeed,
        logTimestamps,
        logMetadata,
        webAppearance,
        webEnabled,
        webPort,
        webRunning: snap?.web?.running === true,
        userPath,
        repoPath,
        localPath,
      }),
    [
      fontSize,
      leaderMs,
      localPath,
      logMetadata,
      logTimestamps,
      mousePref,
      prefsLocked,
      repoPath,
      scope,
      scrollSpeed,
      snap?.mcp?.running,
      snap?.web?.running,
      themeName,
      userPath,
      webAppearance,
      webEnabled,
      webPort,
      writePath,
    ],
  );

  useEffect(() => {
    if (controller?.cfg.web.enabled !== undefined) {
      setWebEnabled(controller.cfg.web.enabled);
    }
    if (controller?.cfg.web.listen.port) {
      setWebPort(controller.cfg.web.listen.port);
      committedWebPort.current = controller.cfg.web.listen.port;
    }
  }, [controller?.cfg.web.enabled, controller?.cfg.web.listen.port]);

  const persistPrefs = useCallback((partial: TuiPreferencePatch, message: string, persistScope: PreferenceScope = scope) => {
    if (prefsLocked) {
      setStatus(`${message}  session only`);
      return;
    }
    const dest = saveTuiPreferences(partial, { repoRoot: repoRoot || process.cwd(), scope: persistScope });
    setStatus(`${message}  saved ${dest}`);
  }, [prefsLocked, repoRoot, saveTuiPreferences, scope, setStatus]);

  const persistLocalWeb = useCallback((patch: LocalWebPatch, message: string) => {
    const root = repoRoot || process.cwd();
    try {
      const dest = patchRepoLocalConfig(root, patch);
      setStatus(`${message}  wrote ${dest}`);
      if (controller) {
        void controller.reload().catch((err: unknown) => setStatus(humanMessage(err)));
      }
    } catch (err: unknown) {
      setStatus(humanMessage(err));
    }
  }, [controller, patchRepoLocalConfig, repoRoot, setStatus]);

  const persistTheme = useCallback((name: string) => {
    setThemeName(name);
    committedTheme.current = name;
    persistPrefs({ theme: name }, `theme ${name}`);
  }, [persistPrefs]);

  const toggleMouse = useCallback(() => {
    const next = !mousePref;
    setMousePref(next);
    committedMouse.current = next;
    persistPrefs({ mouse: next }, `mouse ${next ? "on" : "off"}  restart TUI to apply clicks`);
  }, [mousePref, persistPrefs]);

  const applyLeader = useCallback((ms: number) => {
    setLeaderMs(ms);
    committedLeader.current = ms;
    persistPrefs({ leader_timeout: ms }, `leader ${ms}ms`);
  }, [persistPrefs]);

  const applyFont = useCallback((size: number) => {
    const next = nearestFontSize(size);
    setFontSize(next);
    committedFont.current = next;
    persistPrefs({ font_size: next }, `display ${formatFontSize(next)}`);
  }, [persistPrefs]);

  const applyScroll = useCallback((speed: number) => {
    const next = nearestScrollSpeed(speed);
    setScrollSpeed(next);
    committedScroll.current = next;
    persistPrefs({ scroll_speed: next }, `scroll ${next}`);
  }, [persistPrefs]);

  const applyWebAppearance = useCallback((next: WebAppearance) => {
    setWebAppearance(next);
    committedAppearance.current = next;
    persistPrefs({ web_appearance: next }, `web console ${next}`);
  }, [persistPrefs]);

  const applyLogTimestamps = useCallback((next: boolean) => {
    setLogTimestamps(next);
    committedTimestamps.current = next;
    setLogShowTimestamps?.(next);
    persistPrefs({ log_timestamps: next }, next ? "timestamps on" : "timestamps off");
  }, [persistPrefs, setLogShowTimestamps]);

  const applyLogMetadata = useCallback((next: boolean) => {
    setLogMetadata(next);
    committedMetadata.current = next;
    setLogShowMeta?.(next);
    persistPrefs({ log_metadata: next }, next ? "metadata on" : "metadata off");
  }, [persistPrefs, setLogShowMeta]);

  const toggleWeb = useCallback(() => {
    const next = !webEnabled;
    setWebEnabled(next);
    persistLocalWeb({ web_enabled: next }, `web console ${next ? "on" : "off"}`);
  }, [persistLocalWeb, webEnabled]);

  const applyWebPort = useCallback((port: number) => {
    const next = clampMcpPort(port);
    setWebPort(next);
    committedWebPort.current = next;
    persistLocalWeb({ web_port: next }, `web port ${next}`);
  }, [persistLocalWeb]);

  const previewWebPort = useCallback((port: number) => {
    setWebPort(clampMcpPort(port));
  }, []);

  const applyReset = useCallback(() => {
    const defaults = settingsDefaults();
    setThemeName(defaults.theme ?? "devctl");
    committedTheme.current = defaults.theme ?? "devctl";
    setMousePref(defaults.mouse ?? true);
    committedMouse.current = defaults.mouse ?? true;
    setLeaderMs(defaults.leader_timeout ?? 2000);
    committedLeader.current = defaults.leader_timeout ?? 2000;
    setFontSize(defaults.font_size ?? 14);
    committedFont.current = defaults.font_size ?? 14;
    setScrollSpeed(defaults.scroll_speed ?? 3);
    committedScroll.current = defaults.scroll_speed ?? 3;
    setLogTimestamps(defaults.log_timestamps !== false);
    committedTimestamps.current = defaults.log_timestamps !== false;
    setLogShowTimestamps?.(defaults.log_timestamps !== false);
    setLogMetadata(defaults.log_metadata !== false);
    committedMetadata.current = defaults.log_metadata !== false;
    setLogShowMeta?.(defaults.log_metadata !== false);
    setWebAppearance(defaults.web_appearance ?? "dark");
    committedAppearance.current = defaults.web_appearance ?? "dark";
    persistPrefs(defaults, `restored default preferences (${formatScope(scope)})`);
  }, [persistPrefs, scope, setLogShowMeta, setLogShowTimestamps]);

  const activateSetting = useCallback(
    (item: SettingsItem) => {
      if (item.id === "theme") {
        setPaletteIndex(Math.max(0, THEME_NAMES.indexOf(themeName as (typeof THEME_NAMES)[number])));
        setOverlay("themes");
        return;
      }
      if (item.id === "scope") {
        setScope(cyclePreferenceScope(scope, 1));
        return;
      }
      if (item.id === "mouse") {
        toggleMouse();
        return;
      }
      if (item.id === "leader") {
        applyLeader(leaderMs);
        return;
      }
      if (item.id === "font") {
        applyFont(fontSize);
        return;
      }
      if (item.id === "scroll") {
        applyScroll(scrollSpeed);
        return;
      }
      if (item.id === "web_appearance") {
        applyWebAppearance(cycleWebAppearance(webAppearance, 1));
        return;
      }
      if (item.id === "timestamps") {
        applyLogTimestamps(!logTimestamps);
        return;
      }
      if (item.id === "metadata") {
        applyLogMetadata(!logMetadata);
        return;
      }
      if (item.id === "web") {
        toggleWeb();
        return;
      }
      if (item.id === "web_port") {
        applyWebPort(webPort);
        return;
      }
      if (item.id === "reset") {
        setConfirmKind("reset-prefs");
        setOverlay("confirm");
        return;
      }
      if (item.id === "mcp") {
        setScreen("mcp");
        setSelected(0);
        return;
      }
      setStatus(item.detail);
    },
    [
      applyFont,
      applyLeader,
      applyLogMetadata,
      applyLogTimestamps,
      applyScroll,
      applyWebAppearance,
      applyWebPort,
      fontSize,
      leaderMs,
      logMetadata,
      logTimestamps,
      scope,
      scrollSpeed,
      setConfirmKind,
      setOverlay,
      setPaletteIndex,
      setScreen,
      setSelected,
      setStatus,
      themeName,
      toggleMouse,
      toggleWeb,
      webAppearance,
      webPort,
    ],
  );

  const cycleSetting = useCallback(
    (dir: 1 | -1, listCursor: number) => {
      const item = selectedSettingsItem(settingRows, listCursor);
      if (!item) {
        return;
      }
      if (item.id === "scope") {
        setScope(cyclePreferenceScope(scope, dir));
        return;
      }
      if (item.id === "theme") {
        persistTheme(cycleTheme(themeName, dir));
        return;
      }
      if (item.id === "leader") {
        applyLeader(cycleLeader(leaderMs, dir));
        return;
      }
      if (item.id === "font") {
        applyFont(cycleFontSize(fontSize, dir));
        return;
      }
      if (item.id === "scroll") {
        applyScroll(cycleScrollSpeed(scrollSpeed, dir));
        return;
      }
      if (item.id === "web_appearance") {
        applyWebAppearance(cycleWebAppearance(webAppearance, dir));
        return;
      }
      if (item.id === "web_port") {
        previewWebPort(webPort + dir);
        return;
      }
      if (item.id === "mouse") {
        toggleMouse();
        return;
      }
      if (item.id === "timestamps") {
        applyLogTimestamps(!logTimestamps);
        return;
      }
      if (item.id === "metadata") {
        applyLogMetadata(!logMetadata);
        return;
      }
      if (item.id === "web") {
        toggleWeb();
      }
    },
    [
      applyFont,
      applyLeader,
      applyLogMetadata,
      applyLogTimestamps,
      applyScroll,
      applyWebAppearance,
      previewWebPort,
      fontSize,
      leaderMs,
      logMetadata,
      logTimestamps,
      persistTheme,
      scope,
      scrollSpeed,
      settingRows,
      themeName,
      toggleMouse,
      toggleWeb,
      webAppearance,
      webPort,
    ],
  );

  const revertThemePreview = useCallback(() => {
    setThemeName(committedTheme.current);
  }, []);
  useEffect(() => {
    if (screen === "settings") {
      return;
    }
    setThemeName(committedTheme.current);
    setFontSize(committedFont.current);
    setLeaderMs(committedLeader.current);
    setMousePref(committedMouse.current);
    setScrollSpeed(committedScroll.current);
    setLogTimestamps(committedTimestamps.current);
    setLogMetadata(committedMetadata.current);
    setWebAppearance(committedAppearance.current);
    setWebPort(committedWebPort.current);
  }, [screen]);

  return {
    themeName,
    setThemeName,
    leaderMs,
    fontSize,
    scrollSpeed,
    prefsLocked,
    palette,
    rootBackground,
    settingRows,
    persistPrefs,
    persistTheme,
    toggleMouse,
    applyFont,
    applyReset,
    applyLogTimestamps,
    applyLogMetadata,
    activateSetting,
    cycleSetting,
    revertThemePreview,
    scope,
  };
}
