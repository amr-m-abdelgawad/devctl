import { humanMessage } from "../../../shared/errors.ts";
import { backspaceMcpPortDraft, clampMcpPort, typeMcpPortDigit } from "../../mcp/port.ts";
import { lookupCommand } from "../commands.ts";
import { pageScrollAmount } from "../helpers/chrome.ts";
import { cycleLogService, logWrapLabel, nextLogWrapMode } from "../helpers/logs.ts";
import { restartDependents } from "../helpers/lifecycle.ts";
import { focusedServices } from "../helpers/services.ts";
import { isBound, isClearLogsKey, isPageDownKey, isPageUpKey, isRestartKey, type KeyLike } from "../keymap.ts";
import { scrollBoxBy } from "../layout.tsx";
import { mcpToolAtRow } from "../screens/Mcp.tsx";
import { selectedSettingsItem } from "../settings.ts";
import type { Screen } from "../types.ts";
import type { ScreenKeyCtx } from "./keyboard-context.ts";

export type ScreenDigitCtx = Pick<ScreenKeyCtx, "screen" | "listCursor" | "setMcpPortDraft">;

/** Screen-specific digits must run before navItemForDigit. Returns true when consumed. */
export function handleScreenDigitKey(ctx: ScreenDigitCtx, key: KeyLike): boolean {
  const name = (key.name ?? "").toLowerCase();
  if (ctx.screen === "mcp" && ctx.listCursor === 1 && name.length === 1 && name >= "0" && name <= "9") {
    ctx.setMcpPortDraft((draft) => typeMcpPortDigit(draft, name));
    return true;
  }
  return false;
}

export function handleScreenKey(ctx: ScreenKeyCtx, key: KeyLike): boolean {
  const name = (key.name ?? "").toLowerCase();
  const {
    screen, overlay, tui, cfg, controller, profile, listCursor, names, listCount, height,
    checked, detailName, bootErrorMissing, bootErrorConfig, bootError, logSearchFocused,
    logSources, logService, logShowTimestamps, logShowMeta, logWrap, showSystemLogs,
    logPinned, dashboardLogCursor, applyLogCursor, applyDashboardLogCursor, jumpToLatestLogs,
    toggleSystemLogs, toggleGrpcLogs, clearLogs, setLogService, setPaused, setErrorOnly, setLogWrap, beginStart, beginStop, beginRestart,
    applyMcpPortDraft, toggleMcp, toggleMcpTool, copyFocusedMcpSnippet, persistMcpPort,
    restartMcpOnPort, setMcpPortDraft, settingRows, applyLogTimestamps, applyLogMetadata, cycleSetting,
    setDoctorTick, refreshAuth, configScrollRef, detailScrollRef, handleEnter, setScreen,
    setChecked, setStatus, setSelected, setProfile, refresh,
    toggleChecked, createStarterConfig: _createStarterConfig, startWizard, setConfirmKind, setConfirmDetail, setOverlay, openConfigBuffer,
    runCommand, openEnvPicker, openLogExclude, toggleLlmBodyMode, toggleTrafficBodyMode, moveLlmCursor, moveTrafficCursor,
  } = ctx;

  const onLogFilters = (screen === "logs" || screen === "dashboard") && !logSearchFocused;
  if (onLogFilters && (name === "left" || name === "[" || (screen === "logs" && name === "h"))) {
    setLogService(cycleLogService(logSources, logService, -1));
    return true;
  }
  if (onLogFilters && (name === "right" || name === "]" || (screen === "logs" && name === "l"))) {
    setLogService(cycleLogService(logSources, logService, 1));
    return true;
  }
  if (onLogFilters && screen === "logs" && name === "x") {
    openLogExclude();
    return true;
  }
  if ((screen === "dashboard" || screen === "setup") && name === "o") {
    setScreen("profiles");
    return true;
  }
  if ((screen === "dashboard" || screen === "services") && (name === "*" || (key.shift && name === "8"))) {
    setChecked([...names]);
    setStatus(`Selected ${names.length} services`);
    return true;
  }
  if ((screen === "dashboard" || screen === "services") && (name === "-" || name === "_" || name === "minus")) {
    setChecked([]);
    setStatus("Selection cleared");
    return true;
  }
  if ((screen === "dashboard" || screen === "services" || screen === "detail") && name === "e") {
    openEnvPicker();
    return true;
  }
  if ((screen === "dashboard" || screen === "services") && name === "n") {
    void beginStart(focusedServices(checked, names[listCursor] ?? ""), profile);
    return true;
  }
  if ((screen === "dashboard" || screen === "services") && name === "x") {
    void beginStop(focusedServices(checked, names[listCursor] ?? ""));
    return true;
  }
  if ((screen === "dashboard" || screen === "services" || screen === "detail") && isRestartKey(key)) {
    const targets = focusedServices(checked, names[listCursor] ?? detailName);
    if (cfg && restartDependents(cfg, targets).length > 0) {
      setConfirmKind("restart-cascade");
      setConfirmDetail({ services: targets });
      setOverlay("confirm");
      return true;
    }
    void beginRestart(targets, profile);
    return true;
  }
  if ((screen === "dashboard" || screen === "services") && name === "r") {
    void refresh();
    setStatus("Refreshed");
    return true;
  }
  if (screen === "auth" && name === "r") {
    void refreshAuth();
    return true;
  }
  if (screen === "llm" && name === "r") {
    toggleLlmBodyMode();
    return true;
  }
  if (screen === "proxy" && name === "r") {
    toggleTrafficBodyMode();
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "t") {
    applyLogTimestamps(!logShowTimestamps);
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "m") {
    applyLogMetadata(!logShowMeta);
    return true;
  }
  if (name === "down" || name === "j") {
    if (screen === "mcp" && listCursor === 1) {
      applyMcpPortDraft();
    }
    if (screen === "config") {
      if (listCount > 0) {
        setSelected((i) => Math.min(Math.max(listCount - 1, 0), i + 1));
      }
      scrollBoxBy(configScrollRef.current, tui.scroll_speed);
      return true;
    }
    if (screen === "detail") {
      scrollBoxBy(detailScrollRef.current, tui.scroll_speed);
      return true;
    }
    if (screen === "logs") {
      applyLogCursor(listCursor + 1);
      return true;
    }
    if (screen === "dashboard" && dashboardLogCursor >= 0) {
      applyDashboardLogCursor(dashboardLogCursor + 1);
      return true;
    }
    if (moveCallListCursor(screen, 1, moveLlmCursor, moveTrafficCursor)) {
      return true;
    }
    setSelected((i) => Math.min(Math.max(listCount - 1, 0), i + 1));
    return true;
  }
  if (name === "up" || name === "k") {
    if (screen === "mcp" && listCursor === 1) {
      applyMcpPortDraft();
    }
    if (screen === "config") {
      if (listCount > 0) {
        setSelected((i) => Math.max(0, Math.min(i, Math.max(listCount - 1, 0)) - 1));
      }
      scrollBoxBy(configScrollRef.current, -tui.scroll_speed);
      return true;
    }
    if (screen === "detail") {
      scrollBoxBy(detailScrollRef.current, -tui.scroll_speed);
      return true;
    }
    if (screen === "logs") {
      applyLogCursor(listCursor - 1);
      return true;
    }
    if (screen === "dashboard" && dashboardLogCursor >= 0) {
      applyDashboardLogCursor(dashboardLogCursor - 1);
      return true;
    }
    if (moveCallListCursor(screen, -1, moveLlmCursor, moveTrafficCursor)) {
      return true;
    }
    setSelected((i) => Math.max(0, Math.min(i, Math.max(listCount - 1, 0)) - 1));
    return true;
  }
  if (isPageDownKey(key)) {
    const page = pageScrollAmount(height);
    if (screen === "config") {
      scrollBoxBy(configScrollRef.current, page);
      return true;
    }
    if (screen === "detail") {
      scrollBoxBy(detailScrollRef.current, page);
      return true;
    }
    if (screen === "logs") {
      applyLogCursor(listCursor + page);
      return true;
    }
    if (screen === "dashboard" && (logPinned || dashboardLogCursor >= 0)) {
      applyDashboardLogCursor(Math.max(0, dashboardLogCursor) + page);
      return true;
    }
    if (moveCallListCursor(screen, page, moveLlmCursor, moveTrafficCursor)) {
      return true;
    }
    setSelected((i) => Math.min(Math.max(listCount - 1, 0), i + page));
    return true;
  }
  if (isPageUpKey(key)) {
    const page = pageScrollAmount(height);
    if (screen === "config") {
      scrollBoxBy(configScrollRef.current, -page);
      return true;
    }
    if (screen === "detail") {
      scrollBoxBy(detailScrollRef.current, -page);
      return true;
    }
    if (screen === "logs") {
      applyLogCursor(listCursor - page);
      return true;
    }
    if (screen === "dashboard" && (logPinned || dashboardLogCursor >= 0)) {
      applyDashboardLogCursor(Math.max(0, dashboardLogCursor) - page);
      return true;
    }
    if (moveCallListCursor(screen, -page, moveLlmCursor, moveTrafficCursor)) {
      return true;
    }
    setSelected((i) => Math.max(0, i - page));
    return true;
  }
  if (screen === "proxy" && name === "n") {
    void controller?.proxyStart().then(async () => {
      setStatus("Proxy started");
      await refresh();
    }).catch((err: unknown) => setStatus(humanMessage(err)));
    return true;
  }
  if (screen === "proxy" && name === "x") {
    void controller?.proxyStop().then(async () => {
      setStatus("Proxy stopped");
      await refresh();
    }).catch((err: unknown) => setStatus(humanMessage(err)));
    return true;
  }
  if (screen === "detail" && detailName !== "") {
    if (name === "n") {
      void beginStart([detailName], profile);
      return true;
    }
    if (name === "x") {
      void beginStop([detailName]);
      return true;
    }
    if (name === "o") {
      setScreen("config");
      return true;
    }
    if (name === "l") {
      setLogService(detailName);
      setScreen("logs");
      return true;
    }
  }
  if (screen === "mcp" && listCursor === 1 && (name === "left" || name === "h")) {
    const next = clampMcpPort(applyMcpPortDraft() - 1);
    persistMcpPort(next);
    void restartMcpOnPort(next);
    return true;
  }
  if (screen === "mcp" && listCursor === 1 && (name === "right" || name === "l")) {
    const next = clampMcpPort(applyMcpPortDraft() + 1);
    persistMcpPort(next);
    void restartMcpOnPort(next);
    return true;
  }
  if (screen === "mcp" && listCursor === 1 && (name === "backspace" || name === "delete")) {
    setMcpPortDraft((draft) => backspaceMcpPortDraft(draft));
    return true;
  }
  if (screen === "settings" && (name === "left" || name === "h")) {
    cycleSetting(-1, listCursor);
    return true;
  }
  if (screen === "settings" && (name === "right" || name === "l")) {
    cycleSetting(1, listCursor);
    return true;
  }
  if (name === "space") {
    if (screen === "profiles") {
      const keys = Object.keys(cfg?.profiles ?? {}).sort();
      const pick = keys[listCursor];
      if (pick) {
        setProfile(pick);
        setStatus(`Profile ${pick}`);
      }
      return true;
    }
    if (screen === "mcp") {
      if (listCursor === 0) {
        void toggleMcp();
        return true;
      }
      const tool = mcpToolAtRow(listCursor);
      if (tool) {
        void toggleMcpTool(tool);
        return true;
      }
      copyFocusedMcpSnippet(listCursor);
      return true;
    }
    if (screen === "logs") {
      return true;
    }
    if (screen === "settings") {
      const item = selectedSettingsItem(settingRows, listCursor);
      if (item?.kind === "toggle") {
        cycleSetting(1, listCursor);
      }
      return true;
    }
    const svc = names[listCursor];
    if (svc) {
      toggleChecked(svc);
    }
    return true;
  }
  if (name === "return") {
    if (screen === "setup" && !controller) {
      if (!bootErrorMissing) {
        const fallback = bootErrorConfig
          ? "Existing configuration is invalid — fix it and restart devctl."
          : "Supervisor failed to start — see the bootstrap log, then restart.";
        setStatus(bootError || fallback);
        return true;
      }
      startWizard();
      return true;
    }
    if (screen === "setup" && controller) {
      void beginStart([], profile);
      return true;
    }
    handleEnter();
    return true;
  }
  if (isBound(key, tui, "services", "s") && overlay === "none" && screen !== "logs") {
    setScreen("services");
    return true;
  }
  if (isBound(key, tui, "logs", "l") && overlay === "none" && screen !== "detail" && screen !== "logs" && screen !== "settings") {
    setScreen("logs");
    return true;
  }
  if (isBound(key, tui, "auth", "a") && overlay === "none") {
    setScreen("auth");
    return true;
  }
  if (isBound(key, tui, "proxy", "p") && overlay === "none" && screen !== "logs") {
    setScreen("proxy");
    return true;
  }
  if (isBound(key, tui, "doctor", "d") && overlay === "none" && screen !== "doctor") {
    setScreen("doctor");
    return true;
  }
  // Not on dashboard/logs: `g` is jump-to-latest-logs there (below).
  if (isBound(key, tui, "topology", "g") && overlay === "none" && screen !== "logs" && screen !== "dashboard") {
    setScreen("topology");
    return true;
  }
  if (isBound(key, tui, "config", "c") && overlay === "none") {
    setScreen("config");
    return true;
  }
  if (isBound(key, tui, "setup", "u") && overlay === "none") {
    setScreen("setup");
    return true;
  }
  if (screen === "config" && name === "e") {
    void runCommand(lookupCommand("/edit") ?? { name: "edit", aliases: [], desc: "", leader: "", group: "ui" }, []);
    return true;
  }
  if (screen === "config" && name === "v") {
    openConfigBuffer();
    return true;
  }
  if (screen === "doctor" && name === "r") {
    setDoctorTick((tick) => tick + 1);
    setStatus("Re-running doctor");
    return true;
  }
  if (screen === "logs" && name === "p") {
    setPaused((v) => !v);
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "g") {
    jumpToLatestLogs();
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "w") {
    const next = nextLogWrapMode(logWrap);
    setLogWrap(next);
    setStatus(`Log ${logWrapLabel(next)}`);
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "e") {
    setErrorOnly((v) => !v);
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "i") {
    toggleSystemLogs();
    setStatus(showSystemLogs ? "Hiding internal auth/mcp/devctl/proxy logs" : "Showing internal logs");
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && name === "b") {
    toggleGrpcLogs();
    return true;
  }
  if ((screen === "logs" || screen === "dashboard") && isClearLogsKey(key)) {
    clearLogs();
    return true;
  }
  return false;
}

function moveCallListCursor(
  screen: Screen,
  delta: number,
  moveLlmCursor: (delta: number) => void,
  moveTrafficCursor: (delta: number) => void,
): boolean {
  if (screen === "llm") {
    moveLlmCursor(delta);
    return true;
  }
  if (screen === "proxy") {
    moveTrafficCursor(delta);
    return true;
  }
  return false;
}
