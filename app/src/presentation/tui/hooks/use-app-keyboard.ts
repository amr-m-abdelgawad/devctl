import { type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import type { Report } from "../../../domain/doctor/types.ts";
import type { LogEvent } from "../../../domain/logs/logs.ts";
import type { PortHolder } from "../../../domain/net/ports.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { backspaceMcpPortDraft, clampMcpPort, typeMcpPortDigit } from "../../mcp/port.ts";
import type { McpToolDef } from "../../mcp/tools.ts";
import { leaderAction, lookupCommand, type CommandSpec } from "../commands.ts";
import { pageScrollAmount } from "../helpers/chrome.ts";
import { nextScreen, prevScreen, selectedSlashCommand } from "../helpers/command-catalog.ts";
import { cycleLogService, logWrapLabel, nextLogWrapMode, pickLogService, type LogWrapMode } from "../helpers/logs.ts";
import { navItemForDigit } from "../helpers/navigation.ts";
import { canStartAll, focusedServices } from "../helpers/services.ts";
import {
  isBound,
  isClearLogsKey,
  isCommandChord,
  isCopyChord,
  isCtrlC,
  isHelpChord,
  isLeaderChord,
  isPageDownKey,
  isPageUpKey,
  isPaletteChord,
  isRestartKey,
  isSearchChord,
  overlayConsumesTyping,
  shouldConfirmInterrupt,
  type KeyLike,
} from "../keymap.ts";
import { scrollBoxBy } from "../layout.tsx";
import { HELP_SCROLL_PAGE } from "../overlays/Help.tsx";
import { mcpToolAtRow } from "../screens/Mcp.tsx";
import { cycleFontSize, selectedSettingsItem, settingsDefaults, type SettingsItem } from "../settings.ts";
import { THEME_NAMES } from "../themes.ts";
import { type TuiConfig, type TuiPreferencePatch } from "../tui-config.ts";
import { type ConfirmDetail, type ConfirmKind, type Overlay, type Screen } from "../types.ts";

type Options = {
  tui: TuiConfig;
  controller: Controller | undefined;
  cfg: DevctlConfig | undefined;
  snap: StatusSnapshot | undefined;
  screen: Screen;
  overlay: Overlay;
  onQuit: (detach?: boolean) => void;
  closeOverlay: () => void;
  confirmKind: ConfirmKind;
  portTarget: PortHolder | undefined;
  profile: string;
  listCursor: number;
  names: string[];
  logSlice: LogEvent[];
  doctor: Report | undefined;
  settingRows: SettingsItem[];
  activateSetting: (item: SettingsItem) => void;
  applyMcpPortDraft: () => number;
  toggleMcp: () => void | Promise<void>;
  toggleMcpTool: (tool: McpToolDef) => void | Promise<void>;
  copyFocusedMcpSnippet: (row: number) => boolean;
  beginStart: (targets: string[], profileName: string) => Promise<void>;
  beginStop: (targets: string[]) => Promise<void>;
  beginRestart: (targets: string[], profileName: string) => Promise<void>;
  openDetail: (name: string) => void;
  copyVisibleLogs: (note?: string) => Promise<void>;
  applyFont: (size: number) => void;
  applyReset: () => void;
  fontSize: number;
  height: number;
  planBusy: boolean;
  revertThemePreview: () => void;
  setThemeName: Dispatch<SetStateAction<string>>;
  paletteIndex: number;
  applyTheme: (name: string) => void;
  runCommand: (spec: CommandSpec, args: string[]) => void | Promise<void>;
  saveConfigBuffer: () => void;
  filtered: CommandSpec[];
  slashIndex: number;
  submitSlash: () => void;
  paletteItems: CommandSpec[];
  logSearchFocused: boolean;
  leaderMs: number;
  logsFullscreen: boolean;
  bootErrorMissing: boolean;
  bootError?: string;
  createStarterConfig: (repo: string) => string;
  persistMcpPort: (port: number) => void;
  restartMcpOnPort: (port: number) => Promise<void>;
  cycleSetting: (delta: 1 | -1, cursor: number) => void;
  toggleMouse: () => void;
  toggleChecked: (name: string) => void;
  checked: string[];
  detailName: string;
  refresh: () => Promise<StatusSnapshot | undefined>;
  refreshAuth: () => void | Promise<void>;
  persistPrefs: (partial: TuiPreferencePatch, message: string) => void;
  applyLogCursor: (index: number) => void;
  applyDashboardLogCursor: (index: number) => void;
  dashboardLogCursor: number;
  listCount: number;
  logPinned: boolean;
  logSources: string[];
  logService: string;
  logs: LogEvent[];
  logShowTimestamps: boolean;
  logShowMeta: boolean;
  logWrap: LogWrapMode;
  showSystemLogs: boolean;
  jumpToLatestLogs: () => void;
  toggleSystemLogs: () => void;
  clearLogs: () => void;
  openConfigBuffer: () => void;
  setOverlay: Dispatch<SetStateAction<Overlay>>;
  setConfirmKind: Dispatch<SetStateAction<ConfirmKind>>;
  setConfirmDetail: Dispatch<SetStateAction<ConfirmDetail>>;
  setPortTarget: Dispatch<SetStateAction<PortHolder | undefined>>;
  setLogDetail: Dispatch<SetStateAction<LogEvent | undefined>>;
  setProfile: Dispatch<SetStateAction<string>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setDoctorTick: Dispatch<SetStateAction<number>>;
  setPaletteIndex: Dispatch<SetStateAction<number>>;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setScreen: Dispatch<SetStateAction<Screen>>;
  setSelected: Dispatch<SetStateAction<number>>;
  setChecked: Dispatch<SetStateAction<string[]>>;
  setLogSearchFocused: Dispatch<SetStateAction<boolean>>;
  setLogsFullscreen: Dispatch<SetStateAction<boolean>>;
  setLogService: Dispatch<SetStateAction<string>>;
  setLogShowTimestamps: Dispatch<SetStateAction<boolean>>;
  setLogShowMeta: Dispatch<SetStateAction<boolean>>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  setErrorOnly: Dispatch<SetStateAction<boolean>>;
  setLogWrap: Dispatch<SetStateAction<LogWrapMode>>;
  setMcpPortDraft: Dispatch<SetStateAction<string>>;
  setConfigEditError: Dispatch<SetStateAction<string>>;
  freePort: (holder: PortHolder) => Promise<void>;
  interruptArmedAt: MutableRefObject<number>;
  leaderTimer: MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
  logDetailsScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  scrollTextScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  routeDetailsScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  planScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  helpScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  configScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  detailScrollRef: MutableRefObject<ScrollBoxRenderable | null>;
};

export function useAppKeyboard({
  tui,
  controller,
  cfg,
  snap,
  screen,
  overlay,
  onQuit,
  closeOverlay,
  confirmKind,
  portTarget,
  profile,
  listCursor,
  names,
  logSlice,
  doctor,
  settingRows,
  activateSetting,
  applyMcpPortDraft,
  toggleMcp,
  toggleMcpTool,
  copyFocusedMcpSnippet,
  beginStart,
  beginStop,
  beginRestart,
  openDetail,
  copyVisibleLogs,
  applyFont,
  applyReset,
  fontSize,
  height,
  planBusy,
  revertThemePreview,
  setThemeName,
  paletteIndex,
  applyTheme,
  runCommand,
  saveConfigBuffer,
  filtered,
  slashIndex,
  submitSlash,
  paletteItems,
  logSearchFocused,
  leaderMs,
  logsFullscreen,
  bootErrorMissing,
  bootError,
  createStarterConfig,
  persistMcpPort,
  restartMcpOnPort,
  cycleSetting,
  toggleMouse,
  toggleChecked,
  checked,
  detailName,
  refresh,
  refreshAuth,
  persistPrefs,
  applyLogCursor,
  applyDashboardLogCursor,
  dashboardLogCursor,
  listCount,
  logPinned,
  logSources,
  logService,
  logs,
  logShowTimestamps,
  logShowMeta,
  logWrap,
  showSystemLogs,
  jumpToLatestLogs,
  toggleSystemLogs,
  clearLogs,
  openConfigBuffer,
  setOverlay,
  setConfirmKind,
  setConfirmDetail,
  setPortTarget,
  setLogDetail,
  setProfile,
  setStatus,
  setDoctorTick,
  setPaletteIndex,
  setSlashIndex,
  setQuery,
  setScreen,
  setSelected,
  setChecked,
  setLogSearchFocused,
  setLogsFullscreen,
  setLogService,
  setLogShowTimestamps,
  setLogShowMeta,
  setPaused,
  setErrorOnly,
  setLogWrap,
  setMcpPortDraft,
  setConfigEditError,
  freePort,
  interruptArmedAt,
  leaderTimer,
  logDetailsScrollRef,
  scrollTextScrollRef,
  routeDetailsScrollRef,
  planScrollRef,
  helpScrollRef,
  configScrollRef,
  detailScrollRef,
}: Options): void {
  const requestQuit = useCallback(() => {
    if (cfg?.shutdown.stop_services_on_exit === undefined) {
      setConfirmKind("quit");
      setOverlay("confirm");
      return;
    }
    onQuit(cfg.shutdown.stop_services_on_exit === false);
  }, [cfg, onQuit]);

  const confirmAction = useCallback(() => {
    if (confirmKind === "quit") {
      onQuit(false);
      return;
    }
    if (confirmKind === "reload") {
      closeOverlay();
      const targets = snap?.restart_required ?? [];
      if (targets.length > 0) {
        void beginRestart(targets, profile);
      }
      return;
    }
    if (confirmKind === "reset-prefs") {
      closeOverlay();
      applyReset();
      return;
    }
    if (confirmKind === "free-port") {
      const holder = portTarget;
      closeOverlay();
      if (!holder) {
        return;
      }
      void freePort(holder)
        .then(() => {
          setStatus(`Stopped ${holder.command} (pid ${holder.pid}) on port ${holder.port}`);
          setDoctorTick((tick) => tick + 1);
        })
        .catch((err: unknown) => {
          setStatus(humanMessage(err));
        });
      return;
    }
    closeOverlay();
    void beginStart([], profile);
  }, [applyReset, beginRestart, beginStart, closeOverlay, confirmKind, onQuit, portTarget, profile, snap]);

  const handleEnter = useCallback(() => {
    if (screen === "logs") {
      const event = logSlice[listCursor];
      if (event) {
        setLogDetail(event);
        setOverlay("log-details");
      }
      return;
    }
    if (screen === "profiles") {
      const keys = Object.keys(cfg?.profiles ?? {}).sort();
      const pick = keys[listCursor];
      if (pick) {
        setProfile(pick);
        setConfirmKind("start-profile");
        setOverlay("confirm");
      }
      return;
    }
    if (screen === "doctor") {
      const check = doctor?.checks[listCursor];
      if (check?.action?.kind === "free-port") {
        const holder = check.action.holder;
        setPortTarget(holder);
        setConfirmDetail({ port: holder.port, pid: holder.pid, process: holder.command });
        setConfirmKind("free-port");
        setOverlay("confirm");
      }
      return;
    }
    if (screen === "mcp") {
      if (listCursor === 0) {
        void toggleMcp();
        return;
      }
      if (listCursor === 1) {
        applyMcpPortDraft();
        return;
      }
      const tool = mcpToolAtRow(listCursor);
      if (tool) {
        void toggleMcpTool(tool);
        return;
      }
      copyFocusedMcpSnippet(listCursor);
      return;
    }
    if (screen === "settings") {
      const item = selectedSettingsItem(settingRows, listCursor);
      if (item) {
        activateSetting(item);
      }
      return;
    }
    if (screen === "dashboard" && canStartAll(snap)) {
      void beginStart([], profile);
      return;
    }
    const name = names[listCursor];
    if (name && (screen === "dashboard" || screen === "services")) {
      openDetail(name);
    }
  }, [activateSetting, applyMcpPortDraft, beginStart, cfg, copyFocusedMcpSnippet, doctor, listCursor, logSlice, names, openDetail, profile, screen, settingRows, snap, toggleMcp]);

  useKeyboard((key: KeyLike) => {
    const name = (key.name ?? "").toLowerCase();
    const copyBound = isCopyChord(key, tui);
    const interruptBound = isCtrlC(key, tui);
    if (copyBound && !interruptBound) {
      if (screen === "mcp" && copyFocusedMcpSnippet(listCursor)) {
        return;
      }
      void copyVisibleLogs();
      return;
    }
    if (interruptBound) {
      const now = Date.now();
      if (shouldConfirmInterrupt(now, interruptArmedAt.current)) {
        interruptArmedAt.current = 0;
        requestQuit();
        return;
      }
      interruptArmedAt.current = now;
      const again = "Ctrl+C again to quit";
      if (copyBound) {
        void copyVisibleLogs(again);
      } else {
        setStatus(`Press ${again}`);
      }
      return;
    }
    if (key.ctrl && (name === "=" || name === "+" || name === "plus")) {
      applyFont(cycleFontSize(fontSize, 1));
      return;
    }
    if (key.ctrl && (name === "-" || name === "_" || name === "minus")) {
      applyFont(cycleFontSize(fontSize, -1));
      return;
    }
    if (key.ctrl && name === "0") {
      applyFont(settingsDefaults().font_size);
      return;
    }
    if (overlay === "confirm") {
      if (name === "escape") {
        closeOverlay();
        return;
      }
      if (confirmKind === "quit" && name === "d") {
        onQuit(true);
        return;
      }
      if (name === "return") {
        confirmAction();
      }
      return;
    }
    if (overlay === "log-details" || overlay === "scroll-text") {
      if (name === "escape") {
        closeOverlay();
        return;
      }
      const box = overlay === "log-details" ? logDetailsScrollRef.current : scrollTextScrollRef.current;
      if (name === "down" || name === "j") {
        scrollBoxBy(box, tui.scroll_speed);
        return;
      }
      if (name === "up" || name === "k") {
        scrollBoxBy(box, -tui.scroll_speed);
        return;
      }
      if (isPageDownKey(key)) {
        scrollBoxBy(box, pageScrollAmount(height));
        return;
      }
      if (isPageUpKey(key)) {
        scrollBoxBy(box, -pageScrollAmount(height));
        return;
      }
      return;
    }
    if (overlay === "route-details") {
      if (name === "escape" || name === "return") {
        closeOverlay();
        return;
      }
      if (name === "down" || name === "j") {
        scrollBoxBy(routeDetailsScrollRef.current, tui.scroll_speed);
        return;
      }
      if (name === "up" || name === "k") {
        scrollBoxBy(routeDetailsScrollRef.current, -tui.scroll_speed);
        return;
      }
      return;
    }
    if (overlay === "plan") {
      if (name === "escape" || (name === "return" && !planBusy)) {
        closeOverlay();
        return;
      }
      if (name === "down" || name === "j") {
        scrollBoxBy(planScrollRef.current, tui.scroll_speed);
        return;
      }
      if (name === "up" || name === "k") {
        scrollBoxBy(planScrollRef.current, -tui.scroll_speed);
        return;
      }
      return;
    }
    if (overlay === "help") {
      if (name === "escape") {
        closeOverlay();
        return;
      }
      if (name === "down" || name === "j") {
        scrollBoxBy(helpScrollRef.current, 1);
        return;
      }
      if (name === "up" || name === "k") {
        scrollBoxBy(helpScrollRef.current, -1);
        return;
      }
      if (name === "pagedown" || isPageDownKey(key)) {
        scrollBoxBy(helpScrollRef.current, HELP_SCROLL_PAGE);
        return;
      }
      if (name === "pageup" || isPageUpKey(key)) {
        scrollBoxBy(helpScrollRef.current, -HELP_SCROLL_PAGE);
        return;
      }
      return;
    }
    if (overlay === "themes") {
      if (name === "escape") {
        revertThemePreview();
        closeOverlay();
        return;
      }
      if (name === "down" || name === "j") {
        setPaletteIndex((i) => {
          const next = Math.min(i + 1, THEME_NAMES.length - 1);
          const theme = THEME_NAMES[next];
          if (theme) {
            setThemeName(theme);
          }
          return next;
        });
        return;
      }
      if (name === "up" || name === "k") {
        setPaletteIndex((i) => {
          const next = Math.max(0, i - 1);
          const theme = THEME_NAMES[next];
          if (theme) {
            setThemeName(theme);
          }
          return next;
        });
        return;
      }
      if (name === "return") {
        const theme = THEME_NAMES[paletteIndex % THEME_NAMES.length];
        if (theme) {
          applyTheme(theme);
        }
      }
      return;
    }
    if (overlay === "leader") {
      if (leaderTimer.current) {
        clearTimeout(leaderTimer.current);
      }
      setOverlay("none");
      const action = leaderAction(name);
      const spec = action ? lookupCommand(action) : undefined;
      if (spec) {
        void runCommand(spec, []);
      }
      return;
    }
    if (overlay === "config-edit") {
      if (name === "escape") {
        setConfigEditError("");
        closeOverlay();
        return;
      }
      if (key.ctrl && name === "s") {
        saveConfigBuffer();
        return;
      }
      return;
    }
    if (overlayConsumesTyping(overlay)) {
      if (name === "escape") {
        closeOverlay();
        return;
      }
      if (overlay === "slash" && name === "down") {
        setSlashIndex((i) => Math.min(Math.max(filtered.length - 1, 0), i + 1));
        return;
      }
      if (overlay === "slash" && name === "up") {
        setSlashIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (overlay === "slash" && name === "tab") {
        if (key.shift) {
          setSlashIndex((i) => Math.max(0, i - 1));
          return;
        }
        const pick = selectedSlashCommand(filtered, slashIndex);
        if (pick) {
          setQuery(`${pick.name} `);
        }
        return;
      }
      if (overlay === "slash" && name === "return") {
        submitSlash();
        return;
      }
      if (overlay === "palette" && name === "down") {
        setPaletteIndex((i) => Math.min(i + 1, Math.max(paletteItems.length - 1, 0)));
        return;
      }
      if (overlay === "palette" && name === "up") {
        setPaletteIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (overlay === "palette" && name === "return") {
        const cmd = selectedSlashCommand(paletteItems, paletteIndex);
        if (cmd) {
          void runCommand(cmd, []);
        }
      }
      return;
    }
    if (logSearchFocused) {
      if (name === "escape") {
        setLogSearchFocused(false);
      }
      return;
    }
    if (isLeaderChord(key, tui)) {
      setOverlay("leader");
      leaderTimer.current = setTimeout(() => setOverlay("none"), leaderMs);
      return;
    }
    if (isPaletteChord(key, tui)) {
      setQuery("");
      setPaletteIndex(0);
      setOverlay("palette");
      return;
    }
    if (isCommandChord(key, tui)) {
      setQuery("");
      setSlashIndex(0);
      setOverlay("slash");
      return;
    }
    if (isHelpChord(key, tui)) {
      setOverlay("help");
      return;
    }
    if (isSearchChord(key, tui) || (screen === "logs" && name === "f" && !key.ctrl && !key.meta)) {
      setScreen("logs");
      setLogSearchFocused(true);
      return;
    }
    if (name === "escape") {
      if (logsFullscreen) {
        setLogsFullscreen(false);
        return;
      }
      if (screen === "detail") {
        setScreen("services");
        return;
      }
      if (screen === "setup") {
        if (controller) {
          setScreen("dashboard");
        } else {
          onQuit(true);
        }
      }
      return;
    }
    if (name === "z" && (screen === "logs" || screen === "dashboard") && !key.ctrl && !key.meta) {
      setScreen("logs");
      setLogsFullscreen((current) => (screen === "logs" ? !current : true));
      return;
    }
    const onLogFilters = (screen === "logs" || screen === "dashboard") && !logSearchFocused;
    if (onLogFilters && (name === "left" || name === "[" || (screen === "logs" && name === "h"))) {
      setLogService(cycleLogService(logSources, logService, -1));
      return;
    }
    if (onLogFilters && (name === "right" || name === "]" || (screen === "logs" && name === "l"))) {
      setLogService(cycleLogService(logSources, logService, 1));
      return;
    }
    if (screen === "logs" && !logSearchFocused && name.length === 1 && name >= "1" && name <= "9") {
      const pick = pickLogService(logSources, logs, Number(name));
      if (pick !== undefined) {
        setLogService(pick);
      }
      return;
    }
    if (name === "tab") {
      setScreen(key.shift ? prevScreen(screen) : nextScreen(screen));
      return;
    }
    const jump = navItemForDigit(name);
    if (jump) {
      setScreen(jump);
      return;
    }
    if ((screen === "dashboard" || screen === "setup") && name === "o") {
      setScreen("profiles");
      return;
    }
    if ((screen === "dashboard" || screen === "services") && (name === "*" || (key.shift && name === "8"))) {
      setChecked([...names]);
      setStatus(`Selected ${names.length} services`);
      return;
    }
    if ((screen === "dashboard" || screen === "services") && (name === "-" || name === "_" || name === "minus")) {
      setChecked([]);
      setStatus("Selection cleared");
      return;
    }
    if ((screen === "dashboard" || screen === "services") && name === "n") {
      void beginStart(focusedServices(checked, names[listCursor] ?? ""), profile);
      return;
    }
    if ((screen === "dashboard" || screen === "services") && name === "x") {
      void beginStop(focusedServices(checked, names[listCursor] ?? ""));
      return;
    }
    if ((screen === "dashboard" || screen === "services" || screen === "detail") && isRestartKey(key)) {
      void beginRestart(focusedServices(checked, names[listCursor] ?? detailName), profile);
      return;
    }
    if ((screen === "dashboard" || screen === "services") && name === "r") {
      void refresh();
      setStatus("Refreshed");
      return;
    }
    if (screen === "auth" && name === "r") {
      void refreshAuth();
      return;
    }
    if (screen === "logs" && name === "t") {
      const next = !logShowTimestamps;
      setLogShowTimestamps(next);
      persistPrefs({ log_timestamps: next }, next ? "timestamps on" : "timestamps off");
      return;
    }
    if (screen === "logs" && name === "m") {
      const next = !logShowMeta;
      setLogShowMeta(next);
      persistPrefs({ log_metadata: next }, next ? "metadata on" : "metadata off");
      return;
    }
    if (name === "down" || name === "j") {
      if (screen === "mcp" && listCursor === 1) {
        applyMcpPortDraft();
      }
      if (screen === "config") {
        scrollBoxBy(configScrollRef.current, tui.scroll_speed);
        return;
      }
      if (screen === "detail") {
        scrollBoxBy(detailScrollRef.current, tui.scroll_speed);
        return;
      }
      if (screen === "logs") {
        applyLogCursor(listCursor + 1);
        return;
      }
      if (screen === "dashboard" && dashboardLogCursor >= 0) {
        applyDashboardLogCursor(dashboardLogCursor + 1);
        return;
      }
      setSelected((i) => Math.min(Math.max(listCount - 1, 0), i + 1));
      return;
    }
    if (name === "up" || name === "k") {
      if (screen === "mcp" && listCursor === 1) {
        applyMcpPortDraft();
      }
      if (screen === "config") {
        scrollBoxBy(configScrollRef.current, -tui.scroll_speed);
        return;
      }
      if (screen === "detail") {
        scrollBoxBy(detailScrollRef.current, -tui.scroll_speed);
        return;
      }
      if (screen === "logs") {
        applyLogCursor(listCursor - 1);
        return;
      }
      if (screen === "dashboard" && dashboardLogCursor >= 0) {
        applyDashboardLogCursor(dashboardLogCursor - 1);
        return;
      }
      setSelected((i) => Math.max(0, Math.min(i, Math.max(listCount - 1, 0)) - 1));
      return;
    }
    if (isPageDownKey(key)) {
      const page = pageScrollAmount(height);
      if (screen === "config") {
        scrollBoxBy(configScrollRef.current, page);
        return;
      }
      if (screen === "detail") {
        scrollBoxBy(detailScrollRef.current, page);
        return;
      }
      if (screen === "logs") {
        applyLogCursor(listCursor + page);
        return;
      }
      if (screen === "dashboard" && (logPinned || dashboardLogCursor >= 0)) {
        applyDashboardLogCursor(Math.max(0, dashboardLogCursor) + page);
        return;
      }
      setSelected((i) => Math.min(Math.max(listCount - 1, 0), i + page));
      return;
    }
    if (isPageUpKey(key)) {
      const page = pageScrollAmount(height);
      if (screen === "config") {
        scrollBoxBy(configScrollRef.current, -page);
        return;
      }
      if (screen === "detail") {
        scrollBoxBy(detailScrollRef.current, -page);
        return;
      }
      if (screen === "logs") {
        applyLogCursor(listCursor - page);
        return;
      }
      if (screen === "dashboard" && (logPinned || dashboardLogCursor >= 0)) {
        applyDashboardLogCursor(Math.max(0, dashboardLogCursor) - page);
        return;
      }
      setSelected((i) => Math.max(0, i - page));
      return;
    }
    if (screen === "proxy" && name === "n") {
      void controller?.proxyStart().then(async () => {
        setStatus("Proxy started");
        await refresh();
      });
      return;
    }
    if (screen === "proxy" && name === "x") {
      void controller?.proxyStop().then(async () => {
        setStatus("Proxy stopped");
        await refresh();
      });
      return;
    }
    if (screen === "detail" && detailName !== "") {
      if (name === "n") {
        void beginStart([detailName], profile);
        return;
      }
      if (name === "x") {
        void beginStop([detailName]);
        return;
      }
      if (name === "o") {
        setScreen("config");
        return;
      }
      if (name === "l") {
        setLogService(detailName);
        setScreen("logs");
        return;
      }
    }
    if (screen === "mcp" && listCursor === 1 && (name === "left" || name === "h")) {
      const next = clampMcpPort(applyMcpPortDraft() - 1);
      persistMcpPort(next);
      void restartMcpOnPort(next);
      return;
    }
    if (screen === "mcp" && listCursor === 1 && (name === "right" || name === "l")) {
      const next = clampMcpPort(applyMcpPortDraft() + 1);
      persistMcpPort(next);
      void restartMcpOnPort(next);
      return;
    }
    if (screen === "mcp" && listCursor === 1 && (name === "backspace" || name === "delete")) {
      setMcpPortDraft((draft) => backspaceMcpPortDraft(draft));
      return;
    }
    if (screen === "mcp" && listCursor === 1 && name.length === 1 && name >= "0" && name <= "9") {
      setMcpPortDraft((draft) => typeMcpPortDigit(draft, name));
      return;
    }
    if (screen === "settings" && (name === "left" || name === "h")) {
      cycleSetting(-1, listCursor);
      return;
    }
    if (screen === "settings" && (name === "right" || name === "l")) {
      cycleSetting(1, listCursor);
      return;
    }
    if (name === "space") {
      if (screen === "profiles") {
        const keys = Object.keys(cfg?.profiles ?? {}).sort();
        const pick = keys[listCursor];
        if (pick) {
          setProfile(pick);
          setStatus(`Profile ${pick}`);
        }
        return;
      }
      if (screen === "mcp") {
        if (listCursor === 0) {
          void toggleMcp();
          return;
        }
        const tool = mcpToolAtRow(listCursor);
        if (tool) {
          void toggleMcpTool(tool);
          return;
        }
        copyFocusedMcpSnippet(listCursor);
        return;
      }
      if (screen === "logs") {
        return;
      }
      if (screen === "settings") {
        const item = selectedSettingsItem(settingRows, listCursor);
        if (item?.id === "mouse") {
          toggleMouse();
        }
        return;
      }
      const svc = names[listCursor];
      if (svc) {
        toggleChecked(svc);
      }
      return;
    }
    if (name === "return") {
      if (screen === "setup" && !controller) {
        if (!bootErrorMissing) {
          // The boot error is an existing-but-invalid configuration, not a
          // missing one — offering to "set up" here would silently
          // overwrite whatever the user already has instead of fixing it.
          setStatus(bootError || "Existing configuration is invalid — fix it and restart devctl.");
          return;
        }
        void Promise.resolve().then(() => {
          try {
            const path = createStarterConfig(process.cwd());
            setStatus(`Wrote ${path}. Restart devctl or run the CLI wizard.`);
          } catch (err) {
            setStatus(humanMessage(err));
          }
        });
        return;
      }
      if (screen === "setup" && controller) {
        void beginStart([], profile);
        return;
      }
      handleEnter();
      return;
    }
    if (name === "q") {
      if (cfg?.shutdown.stop_services_on_exit === false) {
        onQuit(true);
        return;
      }
      if (cfg?.shutdown.stop_services_on_exit === true) {
        onQuit(false);
        return;
      }
      setConfirmKind("quit");
      setOverlay("confirm");
      return;
    }
    if (isBound(key, tui, "services", "s") && overlay === "none" && screen !== "logs") {
      setScreen("services");
      return;
    }
    if (isBound(key, tui, "logs", "l") && overlay === "none" && screen !== "detail" && screen !== "logs" && screen !== "settings") {
      setScreen("logs");
      return;
    }
    if (isBound(key, tui, "auth", "a") && overlay === "none") {
      setScreen("auth");
      return;
    }
    if (isBound(key, tui, "proxy", "p") && overlay === "none" && screen !== "logs") {
      setScreen("proxy");
      return;
    }
    if (isBound(key, tui, "doctor", "d") && overlay === "none" && screen !== "doctor") {
      setScreen("doctor");
      return;
    }
    if (isBound(key, tui, "config", "c") && overlay === "none") {
      setScreen("config");
      return;
    }
    if (isBound(key, tui, "setup", "u") && overlay === "none") {
      setScreen("setup");
      return;
    }
    if (screen === "config" && name === "e") {
      void runCommand(lookupCommand("/edit") ?? { name: "edit", aliases: [], desc: "", leader: "", group: "ui" }, []);
      return;
    }
    if (screen === "config" && name === "v") {
      openConfigBuffer();
      return;
    }
    if (screen === "doctor" && name === "r") {
      setDoctorTick((tick) => tick + 1);
      setStatus("Re-running doctor");
      return;
    }
    if (screen === "logs" && name === "p") {
      setPaused((v) => !v);
      return;
    }
    if ((screen === "logs" || screen === "dashboard") && name === "g") {
      jumpToLatestLogs();
      return;
    }
    if ((screen === "logs" || screen === "dashboard") && name === "w") {
      const next = nextLogWrapMode(logWrap);
      setLogWrap(next);
      setStatus(`Log ${logWrapLabel(next)}`);
      return;
    }
    if ((screen === "logs" || screen === "dashboard") && name === "e") {
      setErrorOnly((v) => !v);
      return;
    }
    if ((screen === "logs" || screen === "dashboard") && name === "i") {
      toggleSystemLogs();
      setStatus(showSystemLogs ? "Hiding internal auth/mcp/devctl/proxy logs" : "Showing internal logs");
      return;
    }
    if ((screen === "logs" || screen === "dashboard") && isClearLogsKey(key)) {
      clearLogs();
    }
  });
}
