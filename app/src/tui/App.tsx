import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type Controller } from "../controller.ts";
import { runDoctor, type Report } from "../doctor.ts";
import { freePort, type PortHolder } from "../ports.ts";
import { detectGoogle, type GoogleStatus } from "../google.ts";
import { humanMessage } from "../errors.ts";
import { LogReceived, type BusEvent } from "../events.ts";
import { openInFileManager, resolveExportPath, writeLogExport, type LogEvent } from "../logs.ts";
import { exportsDir } from "../storage.ts";
import { resolveProfile, shutdownPlan, startupPlan, type Plan } from "../services.ts";
import { backspaceMcpPortDraft, clampMcpPort, commitMcpPortDraft, derivedMcpPort, isDerivedMcpPort, typeMcpPortDigit } from "../mcp/port.ts";
import { mcpSnippets, mcpUrl, type McpSnippet } from "../mcp/snippets.ts";
import { type StatusSnapshot } from "../types.ts";
import { allCommands, commandArgs, filterCommands, leaderAction, lookupCommand, type CommandSpec } from "./commands.ts";
import { versionLine } from "../version.ts";
import { CommandLine, Header, NavStrip, StatusBar } from "./chrome.tsx";
import { writeClipboard } from "./clipboard.ts";
import { canStartAll, compactChrome, confirmCopy, cycleLogService, defaultProfileName, explicitServices, filterLogs, focusedServices, formatLogDetails, formatLogsForClipboard, formatPlanSummary, formatStarted, formatStopped, isActiveRuntime, LOG_LIST_TAIL, logCursorStep, logFilterSources, logPinStart, logViewWindow, logWrapLabel, MCP_FOCUS_COUNT, navItemForDigit, nextLogWrapMode, nextScreen, noneStarted, pageScrollAmount, paletteOptions, pickLogService, planServices, prevScreen, screenListCount, selectedSlashCommand, visibleLogs, type LogWrapMode } from "./helpers.ts";
import {
  isBound,
  isCommandChord,
  isCopyChord,
  isCtrlC,
  isHelpChord,
  isLeaderChord,
  isPageDownKey,
  isPageUpKey,
  isPaletteChord,
  isSearchChord,
  overlayConsumesTyping,
  shouldConfirmInterrupt,
  type KeyLike,
} from "./keymap.ts";
import { scrollBoxBy } from "./layout.tsx";
import { ConfirmOverlay } from "./overlays/Confirm.tsx";
import { LogDetailsOverlay } from "./overlays/LogDetails.tsx";
import { HELP_SCROLL_PAGE, HelpOverlay } from "./overlays/Help.tsx";
import { LeaderOverlay } from "./overlays/Leader.tsx";
import { PaletteOverlay } from "./overlays/Palette.tsx";
import { PlanOverlay } from "./overlays/Plan.tsx";
import { SlashOverlay } from "./overlays/Slash.tsx";
import { ThemesOverlay } from "./overlays/Themes.tsx";
import { AuthScreen } from "./screens/Auth.tsx";
import { CredentialsScreen } from "./screens/Credentials.tsx";
import { ConfigScreen } from "./screens/Config.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { DoctorScreen } from "./screens/Doctor.tsx";
import { LogsScreen } from "./screens/Logs.tsx";
import { ProfilesScreen } from "./screens/Profiles.tsx";
import { ProxyScreen } from "./screens/Proxy.tsx";
import { ServiceDetail } from "./screens/ServiceDetail.tsx";
import { ServicesScreen } from "./screens/Services.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SetupScreen } from "./screens/Setup.tsx";
import { McpScreen } from "./screens/Mcp.tsx";
import { DensityContext } from "./density.tsx";
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
  uiScaleFor,
  type SettingsItem,
} from "./settings.ts";
import { paletteFor, THEME_NAMES } from "./themes.ts";
import { type ConfirmDetail, type ConfirmKind, type LifecycleKind, type Overlay, type Screen } from "./types.ts";
import { defaultCopyKeybind, saveTuiPreferences, type TuiConfig, type TuiPreferencePatch } from "./tui-config.ts";

const COMMAND_LOCK_MS = 50;

type AppProps = {
  controller?: Controller;
  tui: TuiConfig;
  onQuit: (detach?: boolean) => void;
  bootError?: string;
};

export function App({ controller, tui, onQuit, bootError }: AppProps) {
  const { width, height } = useTerminalDimensions();
  const [themeName, setThemeName] = useState(tui.theme || controller?.cfg.ui.theme || "devctl");
  const committedTheme = useRef(themeName);
  const [mousePref, setMousePref] = useState(tui.mouse);
  const committedMouse = useRef(tui.mouse);
  const [leaderMs, setLeaderMs] = useState(tui.leader_timeout);
  const committedLeader = useRef(tui.leader_timeout);
  const [fontSize, setFontSize] = useState(() => nearestFontSize(tui.font_size));
  const committedFont = useRef(fontSize);
  const prefsLocked = tuiPrefsLocked();
  const palette = useMemo(() => paletteFor(themeName), [themeName]);
  const [screen, setScreen] = useState<Screen>(controller ? "dashboard" : "setup");
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  const [snap, setSnap] = useState<StatusSnapshot | undefined>();
  const settingRows = useMemo(
    () =>
      settingsItems({
        themeName,
        fontSize,
        mouse: mousePref,
        leaderMs,
        locked: prefsLocked,
        configPath: prefsLocked ? tui.path || prefsSavePath() : prefsSavePath(),
        mcpRunning: snap?.mcp?.running === true,
      }),
    [fontSize, leaderMs, mousePref, prefsLocked, snap?.mcp?.running, themeName, tui.path],
  );
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [errorOnly, setErrorOnly] = useState(false);
  const [status, setStatus] = useState(bootError ?? "");
  const [google, setGoogle] = useState<GoogleStatus | undefined>();
  const [doctor, setDoctor] = useState<Report | undefined>();
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState("");
  const [doctorTick, setDoctorTick] = useState(0);
  const [confirmDetail, setConfirmDetail] = useState<ConfirmDetail>({});
  const [portTarget, setPortTarget] = useState<PortHolder | undefined>();
  const [profile, setProfile] = useState(defaultProfileName(controller?.cfg));
  const [detailName, setDetailName] = useState("");
  const [reveal, setReveal] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const [logSearchFocused, setLogSearchFocused] = useState(false);
  const [logFollow, setLogFollow] = useState(0);
  const [logSince, setLogSince] = useState("");
  const [logService, setLogService] = useState("");
  const [logServices, setLogServices] = useState<string[]>([]);
  const [logShowTimestamps, setLogShowTimestamps] = useState(tui.log_timestamps !== false);
  const [logShowMeta, setLogShowMeta] = useState(tui.log_metadata !== false);
  const [extraLogSources, setExtraLogSources] = useState<string[]>([]);
  const [logLevel] = useState("");
  const [logSource] = useState("");
  const [logRegex, setLogRegex] = useState(false);
  const [logDetail, setLogDetail] = useState<LogEvent | undefined>();
  const [logWrap, setLogWrap] = useState<LogWrapMode>("focus");
  const [logPinned, setLogPinned] = useState(false);
  const [logsFullscreen, setLogsFullscreen] = useState(false);
  const configScrollRef = useRef<ScrollBoxRenderable>(null);
  const helpScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const logDetailsScrollRef = useRef<ScrollBoxRenderable>(null);
  const planScrollRef = useRef<ScrollBoxRenderable>(null);
  const lastExportPath = useRef("");
  const commandBusy = useRef(false);
  const [logViewStart, setLogViewStart] = useState(0);
  const [mcpPortDraft, setMcpPortDraft] = useState("");
  const [plan, setPlan] = useState<Plan | undefined>();
  const [planBusy, setPlanBusy] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleKind>("start");
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>("quit");
  const [mcpPort, setMcpPort] = useState(() => tui.mcp_port ?? derivedMcpPort(controller?.cfg.repoRoot ?? process.cwd()));
  const mcpStarted = useRef(false);
  const leaderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interruptArmedAt = useRef(0);

  const cfg = controller?.cfg;
  const copyKey = tui.keybinds.copy ?? defaultCopyKeybind();
  const names = useMemo(() => Object.keys(cfg?.services ?? {}).sort(), [cfg]);
  const logSources = useMemo(() => logFilterSources(names, logs, extraLogSources), [names, logs, extraLogSources]);
  const filtered = useMemo(() => filterCommands(query), [query]);
  const paletteItems = useMemo(() => paletteOptions(query), [query]);

  useEffect(() => {
    setExtraLogSources((prev) => {
      const found = new Set(prev);
      let changed = false;
      for (const ev of logs) {
        if (ev.service !== "" && !names.includes(ev.service) && !found.has(ev.service)) {
          found.add(ev.service);
          changed = true;
        }
      }
      return changed ? [...found].sort() : prev;
    });
  }, [logs, names]);

  useEffect(() => {
    setSlashIndex(0);
  }, [query]);

  useEffect(() => {
    if (overlay === "palette") {
      setPaletteIndex(0);
    }
  }, [overlay, query]);

  const filteredLogs = useMemo(
    () =>
      filterLogs(logs, {
        service: logService,
        services: logServices,
        errorOnly,
        search: logSearch,
        regex: logRegex,
        source: logSource,
        since: logSince,
      }),
    [errorOnly, logRegex, logSearch, logService, logServices, logSince, logSource, logs],
  );
  const logWindow = useMemo(
    () => logViewWindow(filteredLogs, logPinned, logViewStart),
    [filteredLogs, logPinned, logViewStart],
  );
  const logSlice = logWindow.items;
  const listCount = screenListCount(screen, {
    doctor: doctor?.checks.length ?? 0,
    settings: settingRows.length,
    profiles: Object.keys(cfg?.profiles ?? {}).length,
    services: names.length,
    logs: logSlice.length,
    mcp: MCP_FOCUS_COUNT,
  });
  const listCursor = listCount <= 0 ? selected : Math.min(selected, listCount - 1);

  useEffect(() => {
    if (screen !== "logs") {
      setLogsFullscreen(false);
      return;
    }
    setLogPinned(false);
    setSelected(Math.max(0, Math.min(LOG_LIST_TAIL, filteredLogs.length) - 1));
  }, [errorOnly, logSearch, logService, screen]);

  useEffect(() => {
    if (screen !== "logs" || logPinned) {
      return;
    }
    setSelected(Math.max(0, Math.min(LOG_LIST_TAIL, filteredLogs.length) - 1));
  }, [filteredLogs.length, logPinned, screen]);

  useEffect(() => {
    if (screen === "settings") {
      return;
    }
    setThemeName(committedTheme.current);
    setFontSize(committedFont.current);
    setLeaderMs(committedLeader.current);
    setMousePref(committedMouse.current);
  }, [screen]);

  const pinLogView = useCallback(() => {
    if (!logPinned) {
      setLogViewStart(logPinStart(filteredLogs.length));
      setLogPinned(true);
    }
  }, [filteredLogs.length, logPinned]);

  const applyLogCursor = useCallback(
    (next: number) => {
      const step = logCursorStep(next, listCount, logWindow.start, logWindow.newer);
      if (step.startDelta !== 0) {
        setLogViewStart(Math.max(0, logWindow.start + step.startDelta));
        setLogPinned(true);
        setSelected(step.selected);
        return;
      }
      const last = Math.max(listCount - 1, 0);
      const leaveLatest = listCount > 0 && (step.selected < last || logWindow.newer > 0);
      if (leaveLatest && !logPinned) {
        setLogViewStart(logPinStart(filteredLogs.length));
        setLogPinned(true);
      } else if (!leaveLatest) {
        setLogPinned(false);
      }
      setSelected(step.selected);
    },
    [filteredLogs.length, listCount, logPinned, logWindow.newer, logWindow.start],
  );

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
    (dir: 1 | -1) => {
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
    [applyFont, applyLeader, fontSize, leaderMs, listCursor, persistTheme, settingRows, themeName, toggleMouse],
  );

  const revertThemePreview = useCallback(() => {
    setThemeName(committedTheme.current);
  }, []);

  const refresh = useCallback(async () => {
    if (!controller) {
      return;
    }
    try {
      const next = await controller.status();
      setSnap(next);
      if (next.profile && profile === "") {
        setProfile(next.profile);
      }
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, profile]);

  const persistMcpPort = useCallback(
    (next: number) => {
      const port = clampMcpPort(next);
      setMcpPort(port);
      const root = controller?.cfg.repoRoot ?? process.cwd();
      if (isDerivedMcpPort(root, port)) {
        persistPrefs({ mcp_port: null }, `MCP port ${port} (default)`);
        return;
      }
      persistPrefs({ mcp_port: port }, `MCP port ${port}`);
    },
    [controller, persistPrefs],
  );

  const applyMcpPortDraft = useCallback(() => {
    if (mcpPortDraft === "") {
      return mcpPort;
    }
    const next = commitMcpPortDraft(mcpPortDraft, mcpPort);
    setMcpPortDraft("");
    persistMcpPort(next);
    return next;
  }, [mcpPort, mcpPortDraft, persistMcpPort]);

  const restartMcpOnPort = useCallback(
    async (port: number) => {
      if (!controller || snap?.mcp?.running !== true) {
        return;
      }
      await controller.mcpStop();
      await controller.mcpStart({ port });
      await refresh();
    },
    [controller, refresh, snap?.mcp?.running],
  );

  const toggleMcp = useCallback(async () => {
    if (!controller) {
      setStatus("Supervisor is not running");
      return;
    }
    try {
      if (snap?.mcp?.running) {
        await controller.mcpStop();
        persistPrefs({ mcp_enabled: false }, "MCP off");
        setStatus("MCP stopped");
      } else {
        await controller.mcpStart({ port: mcpPort });
        persistPrefs({ mcp_enabled: true }, "MCP on");
        setStatus("MCP started");
      }
      await refresh();
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, mcpPort, persistPrefs, refresh, snap?.mcp?.running]);

  const copyMcpSnippet = useCallback(
    (snippet: McpSnippet) => {
      void writeClipboard(snippet.text)
        .then(() => {
          setStatus(`Copied ${snippet.title} snippet`);
        })
        .catch((err: unknown) => {
          setStatus(humanMessage(err));
        });
    },
    [],
  );

  const copyFocusedMcpSnippet = useCallback(
    (index: number) => {
      if (index < 2) {
        return false;
      }
      const url = snap?.mcp?.address ?? mcpUrl(snap?.mcp?.port ?? mcpPort);
      const snippet = mcpSnippets(url, snap?.mcp?.token ?? "")[index - 2];
      if (!snippet) {
        return false;
      }
      copyMcpSnippet(snippet);
      return true;
    },
    [copyMcpSnippet, mcpPort, snap?.mcp?.address, snap?.mcp?.port, snap?.mcp?.token],
  );

  const snapRef = useRef(snap);
  snapRef.current = snap;

  const refreshLogs = useCallback(async () => {
    if (!controller || paused) {
      return;
    }
    try {
      const events = await controller.logs({
        level: errorOnly ? "ERROR" : logLevel,
        search: logSearch,
        regex: logRegex,
        source: logSource,
      });
      setLogs(visibleLogs(events, snapRef.current, logSince));
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, errorOnly, logLevel, logRegex, logSearch, logSince, logSource, paused]);

  useEffect(() => {
    void refresh();
    void refreshLogs();
  }, [refresh, refreshLogs]);

  useEffect(() => {
    if (!controller || !tui.mcp_enabled || mcpStarted.current) {
      return;
    }
    mcpStarted.current = true;
    void controller
      .mcpStart({ port: tui.mcp_port ?? mcpPort })
      .then(() => refresh())
      .catch((err: unknown) => {
        setStatus(humanMessage(err));
      });
  }, [controller, mcpPort, refresh, tui.mcp_enabled, tui.mcp_port]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let statusDirty = false;
    const pendingLogs: LogEvent[] = [];
    const cap = controller.cfg.logs.max_memory_events > 0 ? controller.cfg.logs.max_memory_events : 50_000;
    const flush = (): void => {
      timer = undefined;
      if (pendingLogs.length > 0) {
        const batch = pendingLogs.splice(0, pendingLogs.length);
        setLogs((current) => visibleLogs([...current, ...batch], snapRef.current, logSince).slice(-cap));
      }
      if (statusDirty) {
        statusDirty = false;
        void refresh();
      }
    };
    const unsub = controller.onEvent((ev: BusEvent) => {
      if (ev.type === LogReceived && ev.payload && typeof ev.payload === "object" && "event" in ev.payload) {
        const incoming = ev.payload.event as LogEvent;
        if (!paused) {
          pendingLogs.push(incoming);
        }
        if (!timer) {
          timer = setTimeout(flush, 30);
        }
        return;
      }
      statusDirty = true;
      if (!timer) {
        timer = setTimeout(flush, 30);
      }
    });
    return () => {
      unsub();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [controller, logSince, paused, refresh]);

  useEffect(() => {
    void detectGoogle(cfg?.google.project_id ?? "")
      .then(setGoogle)
      .catch((err: unknown) => {
        setStatus(humanMessage(err));
      });
  }, [cfg?.google.project_id]);

  useEffect(() => {
    if (screen !== "doctor" || !cfg) {
      return;
    }
    let cancelled = false;
    setDoctorLoading(true);
    setDoctorError("");
    void runDoctor(cfg)
      .then((report) => {
        if (cancelled) {
          return;
        }
        setDoctor(report);
        setDoctorLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setDoctorError(humanMessage(err));
        setDoctorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [screen, cfg, doctorTick]);

  const openDetail = useCallback((name: string) => {
    setDetailName(name);
    setScreen("detail");
  }, []);

  const beginStart = useCallback(
    async (targets: string[], profileName: string) => {
      if (!controller || !cfg) {
        setStatus("no configuration loaded");
        return;
      }
      try {
        const resolved = resolveProfile(cfg, profileName, targets);
        const nextPlan = startupPlan(cfg, resolved.services, profileName);
        setLifecycle("start");
        setPlan(nextPlan);
        setOverlay("plan");
        setPlanBusy(true);
        if (noneStarted(snap)) {
          setLogSince(new Date().toISOString());
        }
        const needed = resolved.services.filter((name) => !isActiveRuntime(snap?.services[name]));
        const result = await controller.start({
          services: needed.length > 0 ? needed : targets,
          profile: profileName,
        });
        await refresh();
        setPlanBusy(false);
        setStatus(formatStarted(result));
      } catch (err) {
        setPlanBusy(false);
        await refresh();
        setStatus(humanMessage(err));
      }
    },
    [cfg, controller, refresh, snap],
  );

  const beginStop = useCallback(
    async (targets: string[]) => {
      if (!controller || !cfg) {
        setStatus("no configuration loaded");
        return;
      }
      const selected =
        targets.length > 0
          ? targets
          : Object.entries(snap?.services ?? {})
              .filter(([, rt]) => rt.state !== "STOPPED" && rt.state !== "UNKNOWN")
              .map(([name]) => name);
      if (selected.length === 0) {
        setStatus("nothing to stop");
        return;
      }
      try {
        const nextPlan = shutdownPlan(cfg, selected);
        setLifecycle("stop");
        setPlan(nextPlan);
        setOverlay("plan");
        setPlanBusy(true);
        await controller.stop(targets);
        await refresh();
        setPlanBusy(false);
        setStatus(formatStopped(nextPlan));
      } catch (err) {
        setPlanBusy(false);
        await refresh();
        setStatus(humanMessage(err));
      }
    },
    [cfg, controller, refresh, snap],
  );

  const beginRestart = useCallback(
    async (targets: string[], profileName: string) => {
      if (!controller || !cfg) {
        setStatus("no configuration loaded");
        return;
      }
      try {
        const planned = planServices(cfg, targets, profileName);
        const nextPlan = startupPlan(cfg, planned.services, planned.profile);
        setLifecycle("restart");
        setPlan(nextPlan);
        setOverlay("plan");
        setPlanBusy(true);
        await controller.restart(targets);
        await refresh();
        setPlanBusy(false);
        setStatus(formatPlanSummary(nextPlan) === "" ? "Restarted selected services" : `Restarted ${formatPlanSummary(nextPlan)}`);
      } catch (err) {
        setPlanBusy(false);
        await refresh();
        setStatus(humanMessage(err));
      }
    },
    [cfg, controller, refresh],
  );

  const copyVisibleLogs = useCallback(async (note = "") => {
    const text =
      overlay === "log-details" && logDetail
        ? formatLogDetails(logDetail)
        : formatLogsForClipboard(filterLogs(logs, { service: logService, errorOnly, search: logSearch }));
    const suffix = note === "" ? "" : ` · ${note}`;
    if (text.trim() === "") {
      setStatus(`No logs to copy${suffix}`);
      return;
    }
    try {
      await writeClipboard(text);
      const lines = text.split("\n").length;
      const copied = overlay === "log-details" ? "Copied log event" : `Copied ${lines} log lines`;
      setStatus(`${copied}${suffix}`);
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [errorOnly, logDetail, logSearch, logService, logs, overlay]);

  const runCommand = useCallback(
    async (spec: CommandSpec, args: string[]) => {
      if (commandBusy.current) {
        return;
      }
      commandBusy.current = true;
      if (spec.name !== "start" && spec.name !== "stop" && spec.name !== "restart") {
        setOverlay("none");
      }
      setQuery("");
      const targets = explicitServices(args, checked);
      try {
        switch (spec.name) {
          case "exit":
            setConfirmKind("quit");
            setOverlay("confirm");
            return;
          case "help":
            setOverlay("help");
            return;
          case "version":
            setStatus(versionLine());
            return;
          case "themes":
            if (args[0]) {
              persistTheme(args[0]);
              return;
            }
            setPaletteIndex(Math.max(0, THEME_NAMES.indexOf(themeName as (typeof THEME_NAMES)[number])));
            setQuery("");
            setOverlay("themes");
            return;
          case "settings":
            setScreen("settings");
            setSelected(0);
            return;
          case "dashboard":
          case "services":
            setScreen(spec.name);
            return;
          case "logs":
            if (args[0]) {
              setLogService(args[0]);
            }
            setScreen("logs");
            return;
          case "fullscreen":
            setScreen("logs");
            setLogsFullscreen((current) => (screen === "logs" ? !current : true));
            return;
          case "auth":
          case "credentials":
          case "proxy":
          case "mcp":
          case "config":
          case "profiles":
          case "setup":
            setScreen(spec.name);
            return;
          case "reload":
            if (!controller) {
              return;
            }
            void controller.reload().then((result) => {
              setStatus(result.restart_required.length === 0 ? "Configuration reloaded" : `Reload requires restart: ${result.restart_required.join(", ")}`);
              if (result.restart_required.length > 0) {
                setConfirmKind("reload");
                setOverlay("confirm");
              }
              void refresh();
            });
            return;
          case "doctor":
            setScreen("doctor");
            return;
          case "start":
            await beginStart(targets, profile);
            return;
          case "stop":
            await beginStop(targets);
            return;
          case "restart":
            await beginRestart(targets, profile);
            return;
          case "refresh":
            await refresh();
            setStatus("Refreshed status and logs");
            return;
          case "pause":
            setPaused((v) => !v);
            setScreen("logs");
            return;
          case "filter":
            setErrorOnly((v) => !v);
            setScreen("logs");
            return;
          case "clear":
            setLogs([]);
            setLogSince(new Date().toISOString());
            void controller?.clearLogs();
            setStatus("Cleared on-screen log buffer");
            return;
          case "reveal": {
            const next = !reveal;
            setReveal(next);
            setStatus(next ? "Secrets visible this session" : "Secrets hidden");
            return;
          }
          case "wrap": {
            const next = nextLogWrapMode(logWrap);
            setLogWrap(next);
            setStatus(`Log ${logWrapLabel(next)}`);
            return;
          }
          case "copy":
            await copyVisibleLogs();
            return;
          case "export": {
            const dest = resolveExportPath(args[0]);
            if (controller) {
              await controller.logs({
                export: dest,
                services: logServices,
                level: errorOnly ? "ERROR" : logLevel,
                search: logSearch,
                regex: logRegex,
                source: logSource,
              });
            } else {
              writeLogExport(dest, filterLogs(logs, { service: logService, errorOnly, search: logSearch, regex: logRegex, source: logSource }));
            }
            lastExportPath.current = dest;
            setStatus(`Exported ${dest}`);
            return;
          }
          case "exports": {
            const target = lastExportPath.current || exportsDir();
            openInFileManager(target);
            setStatus(`Opened ${exportsDir()}`);
            return;
          }
          case "regex":
            setLogRegex((v) => !v);
            setStatus(logRegex ? "Substring search" : "Regex search");
            return;
          case "since":
            setLogSince(args[0] || new Date(Date.now() - 3_600_000).toISOString());
            setStatus(`Logs since ${args[0] || "1h"}`);
            return;
          case "history": {
            const { listSessions, loadSessionEvents } = await import("../logs.ts");
            const sessions = listSessions();
            const pick = args[0] || sessions[0];
            if (!pick) {
              setStatus("No persisted log sessions");
              return;
            }
            setLogs(loadSessionEvents(pick));
            setStatus(`Loaded session ${pick}`);
            return;
          }
          case "edit": {
            if (!cfg) {
              return;
            }
            const editor = process.env.DEVCTL_EDITOR || process.env.EDITOR;
            const cmd = editor
              ? [editor, cfg.configPath]
              : process.platform === "darwin"
                ? ["open", cfg.configPath]
                : ["xdg-open", cfg.configPath];
            Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
            setStatus(`Opened ${cfg.configPath} in ${cmd[0]}. Run /reload after saving.`);
            return;
          }
          default:
            setStatus(`/${spec.name}`);
        }
      } catch (err) {
        setStatus(humanMessage(err));
      } finally {
        setTimeout(() => {
          commandBusy.current = false;
        }, COMMAND_LOCK_MS);
      }
    },
    [beginRestart, beginStart, beginStop, checked, cfg, controller, copyVisibleLogs, errorOnly, logLevel, logRegex, logSearch, logService, logServices, logSource, logs, logWrap, persistTheme, profile, refresh, reveal, screen, themeName],
  );

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
    if (overlay === "log-details") {
      if (name === "escape") {
        closeOverlay();
        return;
      }
      if (name === "down" || name === "j") {
        scrollBoxBy(logDetailsScrollRef.current, tui.scroll_speed);
        return;
      }
      if (name === "up" || name === "k") {
        scrollBoxBy(logDetailsScrollRef.current, -tui.scroll_speed);
        return;
      }
      if (isPageDownKey(key)) {
        scrollBoxBy(logDetailsScrollRef.current, pageScrollAmount(height));
        return;
      }
      if (isPageUpKey(key)) {
        scrollBoxBy(logDetailsScrollRef.current, -pageScrollAmount(height));
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
      if (screen === "setup" && controller) {
        setScreen("dashboard");
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
    if ((screen === "dashboard" || screen === "services") && name === "r") {
      void refresh();
      setStatus("Refreshed");
      return;
    }
    if ((screen === "dashboard" || screen === "services" || screen === "detail") && name === "R") {
      void beginRestart(focusedServices(checked, names[listCursor] ?? detailName), profile);
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
      cycleSetting(-1);
      return;
    }
    if (screen === "settings" && (name === "right" || name === "l")) {
      cycleSetting(1);
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
        copyFocusedMcpSnippet(listCursor);
        return;
      }
      if (screen === "logs") {
        const svc = logSources[listCursor] || names[listCursor];
        if (svc) {
          setLogServices((current) => (current.includes(svc) ? current.filter((item) => item !== svc) : [...current, svc]));
        }
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
    if (!controller && screen === "setup" && name === "escape") {
      onQuit(true);
      return;
    }
    if (!controller && screen === "setup" && name === "return") {
      void import("../setup.ts").then(({ createStarterConfig }) => {
        try {
          const path = createStarterConfig(process.cwd());
          setStatus(`Wrote ${path}. Restart devctl or run the CLI wizard.`);
        } catch (err) {
          setStatus(humanMessage(err));
        }
      });
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
      setLogPinned(false);
      setSelected(Math.max(0, Math.min(LOG_LIST_TAIL, filteredLogs.length) - 1));
      setLogFollow((tick) => tick + 1);
      setStatus(logWindow.newer > 0 ? `Jumped to latest (+${logWindow.newer} new)` : "Jumped to latest logs");
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
    <box flexDirection="column" width={width} height={height} backgroundColor={palette.background} overflow="hidden">
      {logsFullscreen ? null : (
        <>
          <Header palette={palette} cfg={cfg} snap={snap} google={google} profile={profile} reveal={reveal} width={width} />
          <NavStrip palette={palette} screen={screen} width={width} onSelect={setScreen} />
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
            onOpen={openDetail}
            onSelectIndex={setSelected}
            onToggle={toggleChecked}
            logSources={logSources}
            onFilterService={setLogService}
            onToggleErrors={() => setErrorOnly((v) => !v)}
            wrapMode={logWrap}
            view={logSlice}
            follow={!logPinned}
            onLeaveLatest={pinLogView}
            onPickLog={(index) => {
              const event = logSlice[index];
              if (!event) {
                return;
              }
              applyLogCursor(index);
              setLogDetail(event);
              setScreen("logs");
              setOverlay("log-details");
            }}
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
          />
        ) : null}
        {screen === "detail" ? (
          <ServiceDetail palette={palette} cfg={cfg} snap={snap} name={detailName} reveal={reveal} width={width} envScrollRef={detailScrollRef} />
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
            search={logSearch}
            searchFocused={logSearchFocused}
            followTick={logFollow}
            width={width}
            onSearch={setLogSearch}
            onService={setLogService}
            onToggleErrors={() => setErrorOnly((v) => !v)}
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
            onSelect={applyLogCursor}
            fullscreen={logsFullscreen}
            onLeaveLatest={pinLogView}
            onOpenExports={openExportsFolder}
          />
        ) : null}
        {screen === "auth" ? <AuthScreen palette={palette} cfg={cfg} google={google} identity={snap?.identity} /> : null}
        {screen === "credentials" ? <CredentialsScreen palette={palette} credentials={snap?.credentials} /> : null}
        {screen === "proxy" ? <ProxyScreen palette={palette} snap={snap} /> : null}
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
          />
        ) : null}
        {screen === "doctor" ? (
          <DoctorScreen
            palette={palette}
            report={doctor}
            loading={doctorLoading}
            error={doctorError}
            selected={listCursor}
            onPick={setSelected}
          />
        ) : null}
        {screen === "config" ? <ConfigScreen palette={palette} cfg={cfg} width={width} scrollRef={configScrollRef} /> : null}
        {screen === "profiles" ? (
          <ProfilesScreen palette={palette} cfg={cfg} profile={profile} selected={listCursor} onPick={setSelected} />
        ) : null}
        {screen === "setup" ? <SetupScreen palette={palette} cfg={cfg} google={google} bootError={bootError} step={listCursor} /> : null}
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
      {overlay === "plan" && plan ? (
        <PlanOverlay
          palette={palette}
          plan={plan}
          snap={snap}
          busy={planBusy}
          failed={failedPlan}
          kind={lifecycle}
          termH={height}
          scrollRef={planScrollRef}
          onDismiss={closeOverlay}
        />
      ) : null}
      {overlay === "slash" || overlay === "plan" || logsFullscreen || (compactChrome(height) && overlay === "none") ? null : (
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
