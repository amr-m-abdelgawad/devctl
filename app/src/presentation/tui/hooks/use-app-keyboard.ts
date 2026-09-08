import { useKeyboard } from "@opentui/react";
import { useCallback } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { nextScreen, prevScreen } from "../helpers/command-catalog.ts";
import { navItemForDigit } from "../helpers/navigation.ts";
import { canStartAll } from "../helpers/services.ts";
import {
  isCommandChord,
  isCopyChord,
  isCtrlC,
  isHelpChord,
  isLeaderChord,
  isPaletteChord,
  isSearchChord,
  shouldConfirmInterrupt,
  type KeyLike,
} from "../keymap.ts";
import { mcpToolAtRow } from "../screens/Mcp.tsx";
import { cycleFontSize, selectedSettingsItem, settingsDefaults } from "../settings.ts";
import { type TuiConfig } from "../tui-config.ts";
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
  logView: Pick<ReturnType<typeof useLogView>, "logSlice" | "logSearchFocused" | "logsFullscreen" | "applyLogCursor" | "applyDashboardLogCursor" | "dashboardLogCursor" | "logPinned" | "logSources" | "logService" | "logs" | "logShowTimestamps" | "logShowMeta" | "logWrap" | "showSystemLogs" | "jumpToLatestLogs" | "toggleSystemLogs" | "clearLogs" | "setLogSearchFocused" | "setLogsFullscreen" | "setLogService" | "setLogShowTimestamps" | "setLogShowMeta" | "setPaused" | "setErrorOnly" | "setLogWrap">;
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
    screen, onQuit, closeOverlay, confirmKind, portTarget, profile, listCursor, names,
    copyVisibleLogs, setOverlay, setConfirmKind, setConfirmDetail, setPortTarget, setLogDetail,
    setProfile, setStatus, setSlashIndex, setQuery, setScreen, freePort, openDetail,
  } = ui;
  const {
    logSlice, logSearchFocused, logsFullscreen, setLogSearchFocused, setLogsFullscreen,
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
          diagnostics.setDoctorTick((tick) => tick + 1);
        })
        .catch((err: unknown) => {
          setStatus(humanMessage(err));
        });
      return;
    }
    closeOverlay();
    void beginStart([], profile);
  }, [applyReset, beginRestart, beginStart, closeOverlay, confirmKind, diagnostics, freePort, onQuit, portTarget, profile, setStatus, snap]);

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
  }, [activateSetting, applyMcpPortDraft, beginStart, cfg, copyFocusedMcpSnippet, doctor, listCursor, logSlice, names, openDetail, profile, screen, setConfirmDetail, setConfirmKind, setLogDetail, setOverlay, setPortTarget, setProfile, settingRows, snap, toggleMcp, toggleMcpTool]);

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
    if (handleOverlayKey({
      ...ui, tui, confirmAction, planBusy, leaderTimer,
      logDetailsScrollRef: refs.logDetailsScrollRef,
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
    if (name === "tab") {
      setScreen(key.shift ? prevScreen(screen) : nextScreen(screen));
      return;
    }
    const screenCtx = {
      ...ui, tui, controller, cfg, snap, ...logView, ...lifecycleActions, ...mcp, ...preferences,
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
