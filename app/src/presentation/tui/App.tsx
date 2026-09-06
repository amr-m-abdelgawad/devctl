import { type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Controller } from "../../application/client-runtime.ts";
import type { DevctlConfig } from "../../domain/config/types.ts";
import type { LogEvent } from "../../domain/logs/logs.ts";
import type { PortHolder } from "../../domain/net/ports.ts";
import { humanMessage } from "../../shared/errors.ts";
import { type StatusSnapshot } from "../../types.ts";
import { backspaceMcpPortDraft, clampMcpPort, typeMcpPortDigit } from "../mcp/port.ts";
import { CommandLine, Header, NavStrip, StatusBar } from "./chrome.tsx";
import { writeClipboard } from "./clipboard.ts";
import { allCommands, commandArgs, filterCommands, leaderAction, lookupCommand, type CommandSpec } from "./commands.ts";
import { DensityContext } from "./density.tsx";
import { compactChrome, confirmCopy, pageScrollAmount } from "./helpers/chrome.ts";
import { nextScreen, paletteOptions, prevScreen, selectedSlashCommand } from "./helpers/command-catalog.ts";
import { cycleLogService, formatLogDetails, formatLogsForClipboard, logWrapLabel, nextLogWrapMode, pickLogService } from "./helpers/logs.ts";
import { navItemForDigit, screenListCount } from "./helpers/navigation.ts";
import { canStartAll, defaultProfileName, focusedServices, type ServiceEnvEntry } from "./helpers/services.ts";
import { useCommandDispatcher } from "./hooks/use-command-dispatcher.ts";
import { useConfigEditor } from "./hooks/use-config-editor.ts";
import { useDaemonEvents } from "./hooks/use-daemon-events.ts";
import { useDiagnostics } from "./hooks/use-diagnostics.ts";
import { useLifecycle } from "./hooks/use-lifecycle.ts";
import { useLogView } from "./hooks/use-log-view.ts";
import { useMcpControls } from "./hooks/use-mcp-controls.ts";
import { usePreferences } from "./hooks/use-preferences.ts";
import { useServiceEnvironment } from "./hooks/use-service-environment.ts";
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
} from "./keymap.ts";
import { scrollBoxBy } from "./layout.tsx";
import { ConfigEditOverlay } from "./overlays/ConfigEdit.tsx";
import { ConfirmOverlay } from "./overlays/Confirm.tsx";
import { HELP_SCROLL_PAGE, HelpOverlay } from "./overlays/Help.tsx";
import { LeaderOverlay } from "./overlays/Leader.tsx";
import { LogDetailsOverlay } from "./overlays/LogDetails.tsx";
import { PaletteOverlay } from "./overlays/Palette.tsx";
import { PlanOverlay } from "./overlays/Plan.tsx";
import { RouteDetailsOverlay } from "./overlays/RouteDetails.tsx";
import { ScrollTextOverlay } from "./overlays/ScrollText.tsx";
import { SlashOverlay } from "./overlays/Slash.tsx";
import { ThemesOverlay } from "./overlays/Themes.tsx";
import { AuthScreen } from "./screens/Auth.tsx";
import { ConfigScreen } from "./screens/Config.tsx";
import { CredentialsScreen } from "./screens/Credentials.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { DoctorScreen } from "./screens/Doctor.tsx";
import { LogsScreen } from "./screens/Logs.tsx";
import { mcpRowCount, McpScreen, mcpToolAtRow } from "./screens/Mcp.tsx";
import { ProfilesScreen } from "./screens/Profiles.tsx";
import { ProxyScreen, type RouteDetailInfo } from "./screens/Proxy.tsx";
import { ServiceDetail } from "./screens/ServiceDetail.tsx";
import { ServicesScreen } from "./screens/Services.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SetupScreen } from "./screens/Setup.tsx";
import { StatsScreen } from "./screens/Stats.tsx";
import { cycleFontSize, selectedSettingsItem, settingsDefaults, uiScaleFor } from "./settings.ts";
import { THEME_NAMES } from "./themes.ts";
import { defaultCopyKeybind, type TuiConfig } from "./tui-config.ts";
import { type ConfirmDetail, type ConfirmKind, type Overlay, type Screen } from "./types.ts";
import { type TuiWorkspace } from "./workspace.ts";

type AppProps = {
  controller?: Controller;
  tui: TuiConfig;
  onQuit: (detach?: boolean) => void;
  bootError?: string;
  bootErrorMissing?: boolean;
  terminalBackground?: string | null;
  workspace: TuiWorkspace;
};

export function App({ controller, tui, onQuit, bootError, bootErrorMissing = false, terminalBackground, workspace }: AppProps) {
  const {
    saveTuiPreferences,
    resolveTuiOverridePath,
    userTuiConfigPath,
    validateConfigText,
    freePort,
    openInFileManager,
    exportsDir,
    readTextFile,
    writeTextFile,
    createStarterConfig,
    validate,
  } = workspace;
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [screen, setScreen] = useState<Screen>(controller ? "dashboard" : "setup");
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  const [snap, setSnap] = useState<StatusSnapshot | undefined>();
  const [status, setStatus] = useState(bootError ?? "");
  const [confirmDetail, setConfirmDetail] = useState<ConfirmDetail>({});
  const [portTarget, setPortTarget] = useState<PortHolder | undefined>();
  const [profile, setProfile] = useState(defaultProfileName(controller?.cfg));
  const [detailName, setDetailName] = useState("");
  const [reveal, setReveal] = useState(false);
  const [logDetail, setLogDetail] = useState<LogEvent | undefined>();
  const [routeDetail, setRouteDetail] = useState<RouteDetailInfo | undefined>();
  const [scrollText, setScrollText] = useState<{ title: string; body: string } | undefined>();
  const configScrollRef = useRef<ScrollBoxRenderable>(null);
  const helpScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const logDetailsScrollRef = useRef<ScrollBoxRenderable>(null);
  const routeDetailsScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollTextScrollRef = useRef<ScrollBoxRenderable>(null);
  const planScrollRef = useRef<ScrollBoxRenderable>(null);
  const lastExportPath = useRef("");
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>("quit");
  const leaderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interruptArmedAt = useRef(0);

  const [cfg, setCfg] = useState<DevctlConfig | undefined>(controller?.cfg);
  const leftover = controller?.previousPersisted;
  // Persists across reloads until the next successful one supersedes it —
  // unlike `status`, which is a transient one-line message for the last
  // action, this is state the user needs to keep seeing.
  const [configReloadError, setConfigReloadError] = useState<string | undefined>(undefined);
  const {
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
  } = usePreferences({
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
  });

  const diagnostics = useDiagnostics({ controller, workspace, cfg, snap, screen, configReloadError, setSnap, setStatus });
  const { google, doctor, doctorLoading, doctorError, doctorProgress, setDoctorTick, refreshAuth } = diagnostics;
  const copyKey = tui.keybinds.copy ?? defaultCopyKeybind();
  const names = useMemo(() => Object.keys(cfg?.services ?? {}).sort(), [cfg]);
  const refresh = useCallback(async () => {
    if (!controller) {
      return undefined;
    }
    try {
      const next = await controller.status();
      setSnap(next);
      if (next.profile && profile === "") {
        setProfile(next.profile);
      }
      return next;
    } catch (err) {
      setStatus(humanMessage(err));
      return undefined;
    }
  }, [controller, profile]);

  const logView = useLogView({ controller, tui, names, screen, refresh, setStatus });
  const {
    logs,
    setLogs,
    paused,
    setPaused,
    errorOnly,
    setErrorOnly,
    showSystemLogs,
    logSearch,
    setLogSearch,
    logSearchFocused,
    setLogSearchFocused,
    logFollow,
    logSince,
    logService,
    setLogService,
    logServices,
    logShowTimestamps,
    setLogShowTimestamps,
    logShowMeta,
    setLogShowMeta,
    logSource,
    logRegex,
    logWrap,
    setLogWrap,
    logPinned,
    logSelected,
    logsFullscreen,
    setLogsFullscreen,
    dashboardLogCursor,
    setDashboardLogCursor,
    logFacets,
    logSources,
    filteredLogs,
    logWindow,
    logSlice,
    pinLogView,
    applyLogCursor,
    applyDashboardLogCursor,
    jumpToLatestLogs,
    clearLogs,
    toggleSystemLogs,
  } = logView;

  const filtered = useMemo(() => filterCommands(query), [query]);
  const paletteItems = useMemo(() => paletteOptions(query), [query]);

  useEffect(() => {
    setSlashIndex(0);
  }, [query]);

  useEffect(() => {
    if (overlay === "palette") {
      setPaletteIndex(0);
    }
  }, [overlay, query]);

  const listCount = screenListCount(screen, {
    doctor: doctor?.checks.length ?? 0,
    settings: settingRows.length,
    profiles: Object.keys(cfg?.profiles ?? {}).length,
    services: names.length,
    logs: logSlice.length,
    mcp: mcpRowCount(),
  });
  const cursorState = screen === "logs" ? logSelected : selected;
  const listCursor = listCount <= 0 ? Math.max(0, cursorState) : Math.max(0, Math.min(cursorState, listCount - 1));
  const envService = screen === "detail" ? detailName : screen === "services" ? (names[listCursor] ?? "") : "";
  const { inspectorEnv, inspectorEnvStatus, inspectorEnvError, resolveEnvironment } = useServiceEnvironment({ controller, cfg, envService });
  const closeOverlay = useCallback(() => {
    setOverlay("none");
    setQuery("");
    setLogSearchFocused(false);
    if (leaderTimer.current) {
      clearTimeout(leaderTimer.current);
    }
  }, []);

  const toggleChecked = useCallback((name: string) => {
    setChecked((cur) => (cur.includes(name) ? cur.filter((svc) => svc !== name) : [...cur, name]));
  }, []);

  const {
    mcpPortDraft,
    setMcpPortDraft,
    mcpPort,
    persistMcpPort,
    applyMcpPortDraft,
    restartMcpOnPort,
    toggleMcpTool,
    toggleMcp,
    copyMcpSnippet,
    copyFocusedMcpSnippet,
  } = useMcpControls({
    tui,
    controller,
    cfg,
    persistPrefs,
    snap,
    refresh,
    setStatus,
  });

  useDaemonEvents({ controller, cfg, paused, logSince, refresh, setLogs, setCfg, setConfigReloadError, setStatus });

  const openDetail = useCallback((name: string) => {
    setDetailName(name);
    setScreen("detail");
  }, []);

  const openEnvDetail = useCallback((entry: ServiceEnvEntry) => {
    const body = entry.value !== "" ? entry.value : entry.required ? "(required, not set)" : "(empty)";
    setScrollText({ title: entry.key, body });
    setOverlay("scroll-text");
  }, []);

  const lifecycleActions = useLifecycle({ controller, workspace, cfg, snap, refresh, setStatus, setOverlay });
  const { plan, planInitiallyRunning, planBusy, lifecycle, beginStart, beginStop, beginRestart } = lifecycleActions;

  const copyVisibleLogs = useCallback(async (note = "") => {
    // filteredLogs is the exact set the list itself renders from — reusing
    // it (rather than reconstructing the filter here) is what guarantees
    // this matches every currently active filter, not just the ones this
    // callback happens to remember to pass along.
    const text =
      overlay === "log-details" && logDetail
        ? formatLogDetails(logDetail)
        : overlay === "scroll-text" && scrollText
          ? scrollText.body
          : formatLogsForClipboard(filteredLogs);
    const suffix = note === "" ? "" : ` · ${note}`;
    if (text.trim() === "") {
      setStatus(`No logs to copy${suffix}`);
      return;
    }
    try {
      await writeClipboard(text);
      const lines = text.split("\n").length;
      const copied = overlay === "log-details" ? "Copied log event" : overlay === "scroll-text" ? "Copied overlay text" : `Copied ${lines} log lines`;
      setStatus(`${copied}${suffix}`);
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [filteredLogs, logDetail, overlay, scrollText]);
  const {
    configEditRef,
    configEditText,
    configEditError,
    setConfigEditError,
    openConfigBuffer,
    saveConfigBuffer,
  } = useConfigEditor({
    cfg,
    readTextFile,
    setOverlay,
    setStatus,
    validateConfigText,
    writeTextFile,
    controller,
    setConfirmKind,
    refresh,
  });

  const {
    runCommand,
  } = useCommandDispatcher({
    setOverlay,
    setQuery,
    checked,
    setConfirmKind,
    setStatus,
    persistTheme,
    setPaletteIndex,
    themeName,
    setScreen,
    setSelected,
    screen,
    renderer,
    cfg,
    setScrollText,
    reveal,
    controller,
    refresh,
    profile,
    setReveal,
    resolveEnvironment,
    openDetail,
    copyVisibleLogs,
    lastExportPath,
    openConfigBuffer,
    workspace,
    logView,
    diagnostics,
    lifecycleActions,
  });

  const openExportsFolder = useCallback(() => {
    const target = lastExportPath.current || exportsDir();
    openInFileManager(target);
    setStatus(`Opened ${exportsDir()}`);
  }, []);

  const submitSlash = useCallback(() => {
    const spec = selectedSlashCommand(filtered, slashIndex);
    if (!spec) {
      setStatus(query.trim() === "" ? "pick a command from the list" : `unknown command /${query}`);
      closeOverlay();
      return;
    }
    const typed = lookupCommand(query);
    const args = typed?.name === spec.name ? commandArgs(query) : [];
    void runCommand(spec, args);
  }, [closeOverlay, filtered, query, runCommand, slashIndex]);

  const applyTheme = useCallback(
    (name: string) => {
      persistTheme(name);
      closeOverlay();
    },
    [closeOverlay, persistTheme],
  );

  const pickPalette = useCallback(
    (name: string) => {
      const spec = lookupCommand(name);
      if (spec) {
        void runCommand(spec, []);
      }
    },
    [runCommand],
  );

  const submitCommandLine = useCallback(() => {
    if (overlay === "palette") {
      const cmd = selectedSlashCommand(paletteItems, paletteIndex);
      if (cmd) {
        void runCommand(cmd, []);
      }
      return;
    }
    submitSlash();
  }, [overlay, paletteIndex, paletteItems, runCommand, submitSlash]);

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

  const confirm = confirmCopy(confirmKind, profile, confirmDetail);
  const planned = new Set(plan?.waves.flat() ?? []);
  const failedPlan =
    plan === undefined || lifecycle === "stop"
      ? ""
      : Object.entries(snap?.services ?? {}).find(([name, rt]) => planned.has(name) && rt.state === "FAILED")?.[0] ?? "";

  return (
    <DensityContext.Provider value={uiScaleFor(fontSize)}>
    <box flexDirection="column" width={width} height={height} backgroundColor={rootBackground} overflow="hidden">
      {logsFullscreen ? null : (
        <>
          <Header palette={palette} cfg={cfg} snap={snap} google={google} profile={profile} reveal={reveal} width={width} />
          <NavStrip palette={palette} screen={screen} width={width} onSelect={setScreen} />
          {configReloadError ? (
            <box height={1} paddingLeft={1} backgroundColor={palette.panel} overflow="hidden">
              <text fg={palette.error} wrapMode="none">{`⚠ configuration reload failed: ${configReloadError}`}</text>
            </box>
          ) : null}
        </>
      )}
      <box flexGrow={1} overflow="hidden">
        {screen === "dashboard" ? (
          <Dashboard
            palette={palette}
            cfg={cfg}
            snap={snap}
            logs={logs}
            names={names}
            selected={listCursor}
            checked={checked}
            profile={profile}
            google={google}
            width={width}
            paused={paused}
            followTick={logFollow}
            logService={logService}
            errorOnly={errorOnly}
            showSystemLogs={showSystemLogs}
            onOpen={openDetail}
            onSelectIndex={setSelected}
            selectedLog={dashboardLogCursor}
            onToggle={toggleChecked}
            logSources={logSources}
            onFilterService={setLogService}
            onToggleErrors={() => setErrorOnly((v) => !v)}
            onToggleSystemLogs={toggleSystemLogs}
            onClearLogs={clearLogs}
            onShowErrors={() => {
              setLogService("");
              setErrorOnly(true);
            }}
            wrapMode={logWrap}
            view={logSlice}
            follow={!logPinned}
            onLeaveLatest={pinLogView}
            onPickLog={(index) => {
              const event = logSlice[index];
              if (!event) {
                return;
              }
              setDashboardLogCursor(index);
              setLogDetail(event);
              pinLogView();
            }}
            viewStart={logWindow.start}
            viewTotal={filteredLogs.length}
            newer={logWindow.newer}
            onJumpLatest={jumpToLatestLogs}
            facets={logFacets}
            leftover={leftover}
          />
        ) : null}
        {screen === "services" ? (
          <ServicesScreen
            palette={palette}
            cfg={cfg}
            names={names}
            snap={snap}
            selected={listCursor}
            checked={checked}
            width={width}
            reveal={reveal}
            onOpen={openDetail}
            onSelectIndex={setSelected}
            onToggle={toggleChecked}
            resolvedEnv={inspectorEnv}
            envStatus={inspectorEnvStatus}
            envError={inspectorEnvError}
            onSelectEnv={openEnvDetail}
          />
        ) : null}
        {screen === "detail" ? (
          <ServiceDetail
            palette={palette}
            cfg={cfg}
            snap={snap}
            name={detailName}
            reveal={reveal}
            width={width}
            envScrollRef={detailScrollRef}
            resolvedEnv={inspectorEnv}
            envStatus={inspectorEnvStatus}
            envError={inspectorEnvError}
            onSelectEnv={openEnvDetail}
          />
        ) : null}
        {screen === "logs" ? (
          <LogsScreen
            palette={palette}
            logs={logs}
            names={names}
            logSources={logSources}
            service={logService}
            paused={paused}
            errorOnly={errorOnly}
            showSystemLogs={showSystemLogs}
            search={logSearch}
            searchFocused={logSearchFocused}
            followTick={logFollow}
            width={width}
            onSearch={setLogSearch}
            onService={setLogService}
            onToggleErrors={() => setErrorOnly((v) => !v)}
            onToggleSystemLogs={toggleSystemLogs}
            onClearLogs={clearLogs}
            source={logSource}
            regex={logRegex}
            services={logServices}
            showTimestamps={logShowTimestamps}
            showMeta={logShowMeta}
            view={logSlice}
            wrapMode={logWrap}
            selected={listCursor}
            follow={!logPinned}
            newer={logWindow.newer}
            viewStart={logWindow.start}
            viewTotal={filteredLogs.length}
            onSelect={applyLogCursor}
            fullscreen={logsFullscreen}
            onLeaveLatest={pinLogView}
            onOpenExports={openExportsFolder}
            onJumpLatest={jumpToLatestLogs}
            facets={logFacets}
          />
        ) : null}
        {screen === "auth" ? <AuthScreen palette={palette} cfg={cfg} google={google} identity={snap?.identity} /> : null}
        {screen === "credentials" ? <CredentialsScreen palette={palette} credentials={snap?.credentials} /> : null}
        {screen === "proxy" ? (
          <ProxyScreen
            palette={palette}
            cfg={cfg}
            snap={snap}
            width={width}
            onSelectRoute={(route) => {
              setRouteDetail(route);
              setOverlay("route-details");
            }}
          />
        ) : null}
        {screen === "mcp" ? (
          <McpScreen
            palette={palette}
            snap={snap}
            port={mcpPort}
            portDraft={mcpPortDraft}
            selected={listCursor}
            onPick={setSelected}
            onToggle={() => {
              void toggleMcp();
            }}
            onCopy={copyMcpSnippet}
            onToggleTool={(tool) => {
              void toggleMcpTool(tool);
            }}
          />
        ) : null}
        {screen === "doctor" ? (
          <DoctorScreen
            palette={palette}
            report={doctor}
            loading={doctorLoading}
            progress={doctorProgress}
            error={doctorError}
            selected={listCursor}
            onPick={setSelected}
            onReload={() => {
              setDoctorTick((tick) => tick + 1);
              setStatus("Re-running doctor");
            }}
          />
        ) : null}
        {screen === "stats" ? <StatsScreen palette={palette} cfg={cfg} snap={snap} width={width} onRefresh={refresh} /> : null}
        {screen === "config" ? <ConfigScreen palette={palette} cfg={cfg} width={width} scrollRef={configScrollRef} /> : null}
        {screen === "profiles" ? (
          <ProfilesScreen palette={palette} cfg={cfg} snap={snap} profile={profile} selected={listCursor} onPick={setSelected} />
        ) : null}
        {screen === "setup" ? (
          <SetupScreen issues={cfg ? validate(cfg) : ["configuration not loaded"]} palette={palette} cfg={cfg} google={google} bootError={bootError} bootErrorMissing={bootErrorMissing} step={listCursor} />
        ) : null}
        {screen === "settings" ? (
          <SettingsScreen
            palette={palette}
            items={settingRows}
            selected={listCursor}
            locked={prefsLocked}
            width={width}
            onPick={setSelected}
            onActivate={activateSetting}
          />
        ) : null}
      </box>
      {overlay === "slash" ? (
        <SlashOverlay
          palette={palette}
          items={filtered}
          query={query}
          selected={slashIndex}
          onQuery={setQuery}
          onSubmit={submitCommandLine}
        />
      ) : null}
      {overlay === "palette" ? (
        <PaletteOverlay
          palette={palette}
          items={paletteItems}
          selected={Math.min(paletteIndex, Math.max(paletteItems.length - 1, 0))}
          termW={width}
          termH={height}
          onIndex={setPaletteIndex}
          onPick={pickPalette}
        />
      ) : null}
      {overlay === "themes" ? (
        <ThemesOverlay
          palette={palette}
          themeName={themeName}
          selected={paletteIndex % THEME_NAMES.length}
          termW={width}
          termH={height}
          onIndex={setPaletteIndex}
          onPreview={setThemeName}
          onPick={applyTheme}
        />
      ) : null}
      {overlay === "help" ? (
        <HelpOverlay palette={palette} termW={width} termH={height} copyKey={copyKey} scrollRef={helpScrollRef} />
      ) : null}
      {overlay === "leader" ? <LeaderOverlay palette={palette} termW={width} termH={height} /> : null}
      {overlay === "confirm" ? (
        <ConfirmOverlay palette={palette} title={confirm.title} body={confirm.body} termW={width} termH={height} />
      ) : null}
      {overlay === "log-details" ? (
        <LogDetailsOverlay palette={palette} event={logDetail} termW={width} termH={height} scrollRef={logDetailsScrollRef} />
      ) : null}
      {overlay === "route-details" ? (
        <RouteDetailsOverlay palette={palette} route={routeDetail} termW={width} termH={height} scrollRef={routeDetailsScrollRef} />
      ) : null}
      {overlay === "scroll-text" && scrollText ? (
        <ScrollTextOverlay
          palette={palette}
          title={scrollText.title}
          body={scrollText.body}
          termW={width}
          termH={height}
          scrollRef={scrollTextScrollRef}
        />
      ) : null}
      {overlay === "config-edit" && cfg ? (
        <ConfigEditOverlay
          palette={palette}
          path={cfg.configPath}
          initialValue={configEditText}
          error={configEditError}
          termW={width}
          termH={height}
          textareaRef={configEditRef}
        />
      ) : null}
      {overlay === "plan" && plan ? (
        <PlanOverlay
          palette={palette}
          plan={plan}
          snap={snap}
          busy={planBusy}
          failed={failedPlan}
          kind={lifecycle}
          termW={width}
          termH={height}
          scrollRef={planScrollRef}
          initiallyRunning={planInitiallyRunning}
          onDismiss={closeOverlay}
        />
      ) : null}
      {overlay === "slash" || overlay === "plan" || overlay === "config-edit" || logsFullscreen || (compactChrome(height) && overlay === "none") ? null : (
        <CommandLine palette={palette} overlay={overlay} query={query} onQuery={setQuery} onSubmit={submitCommandLine} />
      )}
      {logsFullscreen ? null : (
        <StatusBar
          palette={palette}
          screen={screen}
          overlay={overlay}
          status={status}
          paused={paused}
          errorOnly={errorOnly}
          width={width}
          copyKey={copyKey}
        />
      )}
    </box>
    </DensityContext.Provider>
  );
}

export function commandCatalog(): CommandSpec[] {
  return allCommands();
}
