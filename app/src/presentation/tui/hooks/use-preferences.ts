import { RGBA } from "@opentui/core";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import { type StatusSnapshot } from "../../../types.ts";
import {
  cycleFontSize,
  cycleLeader,
  cycleTheme,
  formatFontSize,
  nearestFontSize,
  prefsSavePath,
  selectedSettingsItem,
  settingsDefaults,
  settingsItems,
  tuiPrefsLocked,
  type SettingsItem,
} from "../settings.ts";
import { isDarkTerminalBackground, paletteFor, resolveThemeName, THEME_NAMES } from "../themes.ts";
import { type TuiConfig, type TuiPreferencePatch } from "../tui-config.ts";
import { type ConfirmKind, type Overlay, type Screen } from "../types.ts";

type Options = {
  tui: TuiConfig;
  controller: Controller | undefined;
  resolveTuiOverridePath: (startDir?: string | undefined) => string | undefined;
  terminalBackground: string | null | undefined;
  userTuiConfigPath: () => string;
  snap: StatusSnapshot | undefined;
  setStatus: Dispatch<SetStateAction<string>>;
  saveTuiPreferences: (partial: TuiPreferencePatch) => string;
  setPaletteIndex: Dispatch<SetStateAction<number>>;
  setOverlay: Dispatch<SetStateAction<Overlay>>;
  setConfirmKind: Dispatch<SetStateAction<ConfirmKind>>;
  setScreen: Dispatch<SetStateAction<Screen>>;
  setSelected: Dispatch<SetStateAction<number>>;
  screen: Screen;
};

export function usePreferences({
  tui,
  controller,
  resolveTuiOverridePath,
  terminalBackground,
  userTuiConfigPath,
  snap,
  setStatus,
  saveTuiPreferences,
  setPaletteIndex,
  setOverlay,
  setConfirmKind,
  setScreen,
  setSelected,
  screen,
}: Options) {

  const [themeName, setThemeName] = useState(tui.theme || controller?.cfg.ui.theme || "devctl");
  const committedTheme = useRef(themeName);
  const [mousePref, setMousePref] = useState(tui.mouse);
  const committedMouse = useRef(tui.mouse);
  const [leaderMs, setLeaderMs] = useState(tui.leader_timeout);
  const committedLeader = useRef(tui.leader_timeout);
  const [fontSize, setFontSize] = useState(() => nearestFontSize(tui.font_size));
  const committedFont = useRef(fontSize);
  const prefsLocked = tuiPrefsLocked(resolveTuiOverridePath());
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
        configPath: prefsLocked ? tui.path || prefsSavePath(resolveTuiOverridePath(), userTuiConfigPath()) : prefsSavePath(resolveTuiOverridePath(), userTuiConfigPath()),
        mcpRunning: snap?.mcp?.running === true,
      }),
    [fontSize, leaderMs, mousePref, prefsLocked, snap?.mcp?.running, themeName, tui.path],
  );

  const persistPrefs = useCallback((partial: TuiPreferencePatch, message: string) => {
    if (prefsLocked) {
      setStatus(`${message}  session only`);
      return;
    }
    const dest = saveTuiPreferences(partial);
    setStatus(`${message}  saved ${dest}`);
  }, [prefsLocked]);

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

  const applyReset = useCallback(() => {
    const defaults = settingsDefaults();
    setThemeName(defaults.theme);
    committedTheme.current = defaults.theme;
    setMousePref(defaults.mouse);
    committedMouse.current = defaults.mouse;
    setLeaderMs(defaults.leader_timeout);
    committedLeader.current = defaults.leader_timeout;
    setFontSize(defaults.font_size);
    committedFont.current = defaults.font_size;
    persistPrefs(defaults, "restored default preferences");
  }, [persistPrefs]);

  const activateSetting = useCallback(
    (item: SettingsItem) => {
      if (item.id === "theme") {
        setPaletteIndex(Math.max(0, THEME_NAMES.indexOf(themeName as (typeof THEME_NAMES)[number])));
        setOverlay("themes");
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
    [applyFont, applyLeader, fontSize, leaderMs, themeName, toggleMouse],
  );

  const cycleSetting = useCallback(
    (dir: 1 | -1, listCursor: number) => {
      const item = selectedSettingsItem(settingRows, listCursor);
      if (!item) {
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
      if (item.id === "mouse") {
        toggleMouse();
      }
    },
    [applyFont, applyLeader, fontSize, leaderMs, persistTheme, settingRows, themeName, toggleMouse],
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
  }, [screen]);

  return {
    themeName,
    setThemeName,
    leaderMs,
    fontSize,
    prefsLocked,
    palette,
    rootBackground,
    settingRows,
    persistPrefs,
    persistTheme,
    toggleMouse,
    applyFont,
    applyReset,
    activateSetting,
    cycleSetting,
    revertThemePreview,
  };
}
