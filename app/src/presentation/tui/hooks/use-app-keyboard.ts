import { useKeyboard } from "@opentui/react";
import { useCallback } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { lookupCommand } from "../commands.ts";
import { nextScreen, prevScreen } from "../helpers/command-catalog.ts";
import { navItemForDigit } from "../helpers/navigation.ts";
import { canStartAll } from "../helpers/services.ts";
import {
  isCommandChord,
  isCopyChord,
  isHelpChord,
  isLeaderChord,
  isPaletteChord,
  isQuitKey,
  isSearchChord,
  shouldConfirmInterrupt,
  type KeyLike,
} from "../keymap.ts";
import { mcpToolAtRow } from "../screens/Mcp.tsx";
import { cycleFontSize, selectedSettingsItem, settingsDefaults } from "../settings.ts";
import { hasPrimaryMod, type TuiConfig } from "../tui-config.ts";
import type { useDiagnostics } from "./use-diagnostics.ts";
import type { useLifecycle } from "./use-lifecycle.ts";
import type { useLogView } from "./use-log-view.ts";
import type { useMcpControls } from "./use-mcp-controls.ts";
import type { usePreferences } from "./use-preferences.ts";
import type { KeyboardRefs, KeyboardUi } from "./keyboard-context.ts";
import { handleOverlayKey } from "./keyboard-overlays.ts";
import { handleScreenDigitKey, handleScreenKey } from "./keyboard-screens.ts";

type Options = {
  tui: TuiConfig;
  controller: Controller | undefined;
  cfg: DevctlConfig | undefined;
  snap: StatusSnapshot | undefined;
  ui: KeyboardUi;
  logView: Pick<ReturnType<typeof useLogView>, "logSlice" | "logSliceB" | "logSearchFocused" | "logsFullscreen" | "applyLogCursor" | "applyDashboardLogCursor" | "dashboardLogCursor" | "logPinned" | "logSources" | "logService" | "logServiceB" | "splitLogs" | "splitFocus" | "toggleSplitLogs" | "cycleSplitFocus" | "setActiveLogService" | "logs" | "logShowTimestamps" | "logShowMeta" | "logWrap" | "showSystemLogs" | "jumpToLatestLogs" | "toggleSystemLogs" | "clearLogs" | "setLogSearchFocused" | "setLogsFullscreen" | "setLogService" | "setLogShowTimestamps" | "setLogShowMeta" | "setPaused" | "setErrorOnly" | "setLogWrap">;
  lifecycleActions: Pick<ReturnType<typeof useLifecycle>, "beginStart" | "beginStop" | "beginRestart" | "planBusy">;
  mcp: Pick<ReturnType<typeof useMcpControls>, "applyMcpPortDraft" | "toggleMcp" | "toggleMcpTool" | "copyFocusedMcpSnippet" | "persistMcpPort" | "restartMcpOnPort" | "setMcpPortDraft">;
  preferences: Pick<ReturnType<typeof usePreferences>, "settingRows" | "activateSetting" | "applyFont" | "applyReset" | "fontSize" | "revertThemePreview" | "setThemeName" | "leaderMs" | "cycleSetting" | "toggleMouse" | "persistPrefs">;
  diagnostics: Pick<ReturnType<typeof useDiagnostics>, "doctor" | "refreshAuth" | "setDoctorTick">;
  refs: KeyboardRefs;
};

export function useAppKeyboard({
  tui,
  controller,
  cfg,
  snap,
  ui,
  logView,
  lifecycleActions,
  mcp,
  preferences,
  diagnostics,
  refs,
}: Options): void {
  const {
    screen, onQuit, closeOverlay, confirmKind, confirmDetail, portTarget, profile, listCursor, names, runCommand,
    copySelection, setOverlay, setConfirmKind, setConfirmDetail, setPortTarget, setLogDetail,
    setProfile, setStatus, setSlashIndex, setQuery, setSlashPicker, setScreen, freePort, openDetail,
  } = ui;
  const {
    logSlice, logSliceB, logSearchFocused, logsFullscreen, setLogSearchFocused, setLogsFullscreen,
    splitLogs, splitFocus, toggleSplitLogs, cycleSplitFocus, setActiveLogService, logService, logServiceB,
  } = logView;
  const { beginStart, beginRestart, planBusy } = lifecycleActions;
  const { applyMcpPortDraft, toggleMcp, toggleMcpTool, copyFocusedMcpSnippet } = mcp;
  const { settingRows, activateSetting, applyFont, applyReset, fontSize, revertThemePreview, setThemeName, leaderMs } = preferences;
  const { doctor } = diagnostics;
  const { interruptArmedAt, leaderTimer } = refs;

  const requestQuit = useCallback(() => {
    if (cfg?.shutdown.stop_services_on_exit === undefined) {
      setConfirmKind("quit");
      setOverlay("confirm");
      return;
    }
    onQuit(cfg.shutdown.stop_services_on_exit === false);
  }, [cfg, onQuit, setConfirmKind, setOverlay]);

  const confirmAction = useCallback((mode?: "cascade") => {
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
    if (confirmKind === "restart-cascade") {
      const targets = confirmDetail?.services ?? [];
      closeOverlay();
      void beginRestart(targets, profile, mode === "cascade");
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
          diagnostics.setDoctorTick((tick) => tick + 1);
        })
        .catch((err: unknown) => {
          setStatus(humanMessage(err));
        });
      return;
    }
    closeOverlay();
    void beginStart([], profile);
  }, [applyReset, beginRestart, beginStart, closeOverlay, confirmDetail, confirmKind, diagnostics, freePort, onQuit, portTarget, profile, setStatus, snap]);

  const handleEnter = useCallback(() => {
    if (screen === "logs") {
      const event = (splitLogs && splitFocus === 1 ? logSliceB : logSlice)[listCursor];
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
    if (screen === "config") {
      const task = Object.keys(cfg?.tasks ?? {}).sort()[listCursor];
      const run = lookupCommand("run");
      if (task && run) {
        void runCommand(run, [task]);
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
  }, [activateSetting, applyMcpPortDraft, beginStart, cfg, copyFocusedMcpSnippet, doctor, listCursor, logSlice, logSliceB, names, openDetail, profile, runCommand, screen, setConfirmDetail, setConfirmKind, setLogDetail, setOverlay, setPortTarget, setProfile, settingRows, snap, splitFocus, splitLogs, toggleMcp, toggleMcpTool]);

  useKeyboard((key: KeyLike) => {
    const name = (key.name ?? "").toLowerCase();
    if (isCopyChord(key, tui)) {
      void copySelection();
      return;
    }
    if (hasPrimaryMod(key) && (name === "=" || name === "+" || name === "plus")) {
      applyFont(cycleFontSize(fontSize, 1));
      return;
    }
    if (hasPrimaryMod(key) && (name === "-" || name === "_" || name === "minus")) {
      applyFont(cycleFontSize(fontSize, -1));
      return;
    }
    if (hasPrimaryMod(key) && name === "0") {
      applyFont(settingsDefaults().font_size);
      return;
    }
    if (screen === "logs" && !logSearchFocused && (key.sequence === "\\" || name === "\\")) {
      toggleSplitLogs();
      setStatus(splitLogs ? "Single log pane" : "Split log panes");
      return;
    }
    if (screen === "logs" && !logSearchFocused && (key.sequence === "|" || name === "|")) {
      cycleSplitFocus();
      return;
    }
    if (handleOverlayKey({
      ...ui, tui, confirmAction, planBusy, leaderTimer,
      logDetailsScrollRef: refs.logDetailsScrollRef,
      traceScrollRef: refs.traceScrollRef,
      traceDetailScrollRef: refs.traceDetailScrollRef,
      scrollTextScrollRef: refs.scrollTextScrollRef,
      routeDetailsScrollRef: refs.routeDetailsScrollRef,
      planScrollRef: refs.planScrollRef,
      helpScrollRef: refs.helpScrollRef,
      revertThemePreview, setThemeName,
    }, key)) {
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
    if (isPaletteChord(key, tui) || isCommandChord(key, tui)) {
      setQuery("");
      setSlashIndex(0);
      setSlashPicker("commands");
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
    if (name === "escape" || isQuitKey(key)) {
      if (name === "escape") {
        if (logsFullscreen) {
          setLogsFullscreen(false);
          return;
        }
        if (screen === "detail") {
          setScreen("services");
          return;
        }
        if (screen === "setup" && controller) {
          setScreen("dashboard");
          return;
        }
      }
      const now = Date.now();
      if (shouldConfirmInterrupt(now, interruptArmedAt.current)) {
        interruptArmedAt.current = 0;
        requestQuit();
        return;
      }
      interruptArmedAt.current = now;
      setStatus(name === "q" ? "q again to quit" : "Esc again to quit");
      return;
    }
    if (name === "z" && (screen === "logs" || screen === "dashboard") && !key.ctrl && !key.meta) {
      setScreen("logs");
      setLogsFullscreen((current) => (screen === "logs" ? !current : true));
      return;
    }
    if (name === "tab") {
      setScreen(key.shift ? prevScreen(screen) : nextScreen(screen));
      return;
    }
    const screenCtx = {
      ...ui, tui, controller, cfg, snap, ...logView, ...lifecycleActions, ...mcp, ...preferences,
      logService: splitLogs && splitFocus === 1 ? logServiceB : logService,
      setLogService: setActiveLogService,
      setDoctorTick: diagnostics.setDoctorTick, refreshAuth: diagnostics.refreshAuth,
      configScrollRef: refs.configScrollRef, detailScrollRef: refs.detailScrollRef, handleEnter,
    };
    if (handleScreenDigitKey(screenCtx, key)) {
      return;
    }
    const jump = navItemForDigit(name);
    if (jump) {
      setScreen(jump);
      return;
    }
    handleScreenKey(screenCtx, key);
  });
}
