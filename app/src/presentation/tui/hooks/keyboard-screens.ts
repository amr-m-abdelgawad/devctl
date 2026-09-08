import { backspaceMcpPortDraft, clampMcpPort, typeMcpPortDigit } from "../../mcp/port.ts";
import { lookupCommand } from "../commands.ts";
import { pageScrollAmount } from "../helpers/chrome.ts";
import { cycleLogService, logWrapLabel, nextLogWrapMode, pickLogService } from "../helpers/logs.ts";
import { focusedServices } from "../helpers/services.ts";
import { isBound, isClearLogsKey, isPageDownKey, isPageUpKey, isRestartKey, type KeyLike } from "../keymap.ts";
import { scrollBoxBy } from "../layout.tsx";
import { mcpToolAtRow } from "../screens/Mcp.tsx";
import { selectedSettingsItem } from "../settings.ts";
import { humanMessage } from "../../../shared/errors.ts";
import type { ScreenKeyCtx } from "./keyboard-context.ts";

export type ScreenDigitCtx = Pick<ScreenKeyCtx, "screen" | "logSearchFocused" | "logs" | "logSources" | "setLogService" | "listCursor" | "setMcpPortDraft">;

/** Screen-specific digits must run before navItemForDigit. Returns true when consumed. */
export function handleScreenDigitKey(ctx: ScreenDigitCtx, key: KeyLike): boolean {
  const name = (key.name ?? "").toLowerCase();
  if (ctx.screen === "logs" && !ctx.logSearchFocused && name.length === 1 && name >= "1" && name <= "9") {
    const pick = pickLogService(ctx.logSources, ctx.logs, Number(name));
    if (pick !== undefined) {
      ctx.setLogService(pick);
    }
    return true;
  }
  if (ctx.screen === "mcp" && ctx.listCursor === 1 && name.length === 1 && name >= "0" && name <= "9") {
    ctx.setMcpPortDraft((draft) => typeMcpPortDigit(draft, name));
    return true;
  }
  return false;
}

export function handleScreenKey(ctx: ScreenKeyCtx, key: KeyLike): void {
  const name = (key.name ?? "").toLowerCase();
  const {
    screen, overlay, tui, cfg, controller, profile, listCursor, names, listCount, height,
    checked, detailName, bootErrorMissing, bootError, logSearchFocused,
    logSources, logService, logShowTimestamps, logShowMeta, logWrap, showSystemLogs,
    logPinned, dashboardLogCursor, applyLogCursor, applyDashboardLogCursor, jumpToLatestLogs,
    toggleSystemLogs, clearLogs, setLogService, setLogShowTimestamps,
    setLogShowMeta, setPaused, setErrorOnly, setLogWrap, beginStart, beginStop, beginRestart,
    applyMcpPortDraft, toggleMcp, toggleMcpTool, copyFocusedMcpSnippet, persistMcpPort,
    restartMcpOnPort, setMcpPortDraft, settingRows, persistPrefs, cycleSetting, toggleMouse,
    setDoctorTick, refreshAuth, configScrollRef, detailScrollRef, handleEnter, setScreen,
    setChecked, setStatus, setSelected, setProfile, refresh,
    toggleChecked, createStarterConfig, onQuit, setConfirmKind, setOverlay, openConfigBuffer,
    runCommand,
  } = ctx;

  const onLogFilters = (screen === "logs" || screen === "dashboard") && !logSearchFocused;
  if (onLogFilters && (name === "left" || name === "[" || (screen === "logs" && name === "h"))) {
    setLogService(cycleLogService(logSources, logService, -1));
    return;
  }
  if (onLogFilters && (name === "right" || name === "]" || (screen === "logs" && name === "l"))) {
    setLogService(cycleLogService(logSources, logService, 1));
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
}
