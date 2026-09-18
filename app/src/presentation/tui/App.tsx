import { type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Controller } from "../../application/client-runtime.ts";
import type { DevctlConfig } from "../../domain/config/types.ts";
import type { LogEvent } from "../../domain/logs/logs.ts";
import type { TraceResponse } from "../../domain/status.ts";
import type { PortHolder } from "../../domain/net/ports.ts";
import { serviceHasNamedEnvironments } from "../../domain/service/environments.ts";
import { humanMessage } from "../../shared/errors.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { Header, NavStrip, NoticeBar, StatusBar } from "./chrome.tsx";
import { writeClipboard } from "./clipboard.ts";
import { lookupCommand } from "./commands.ts";
import { DensityContext } from "./density.tsx";
import { confirmCopy } from "./helpers/chrome.ts";
import { namedPickerItems, paletteOptions, selectedSlashCommand, slashSubmitArgs } from "./helpers/command-catalog.ts";
import { screenListCount } from "./helpers/navigation.ts";
import { matchProxyRequest } from "./helpers/proxy.ts";
import { defaultProfileName, serviceEnvOptions, shouldConfirmEnvSwitch, type ServiceEnvEntry } from "./helpers/services.ts";
import { clampTraceSpanIndex, orderTraceRows } from "./helpers/traces.ts";
import { useAppKeyboard } from "./hooks/use-app-keyboard.ts";
import { useCommandDispatcher } from "./hooks/use-command-dispatcher.ts";
import { useConfigEditor } from "./hooks/use-config-editor.ts";
import { useDaemonEvents } from "./hooks/use-daemon-events.ts";
import { useDiagnostics } from "./hooks/use-diagnostics.ts";
import { useLifecycle } from "./hooks/use-lifecycle.ts";
import { useLogView } from "./hooks/use-log-view.ts";
import { useLlmView } from "./hooks/use-llm-view.ts";
import { useMcpControls } from "./hooks/use-mcp-controls.ts";
import { useNotifications } from "./hooks/use-notifications.ts";
import { usePreferences } from "./hooks/use-preferences.ts";
import { useSetupWizard } from "./hooks/use-setup-wizard.ts";
import { useServiceEnvironment } from "./hooks/use-service-environment.ts";
import { ConfigEditOverlay } from "./overlays/ConfigEdit.tsx";
import { ConfirmOverlay } from "./overlays/Confirm.tsx";
import { EnvOverlay } from "./overlays/Env.tsx";
import { HelpOverlay } from "./overlays/Help.tsx";
import { LeaderOverlay } from "./overlays/Leader.tsx";
import { LogDetailsOverlay } from "./overlays/LogDetails.tsx";
import { LlmDetailsOverlay } from "./overlays/LlmDetails.tsx";
import { PlanOverlay } from "./overlays/Plan.tsx";
import { RouteDetailsOverlay } from "./overlays/RouteDetails.tsx";
import { ScrollTextOverlay } from "./overlays/ScrollText.tsx";
import { SetupWizardOverlay } from "./overlays/SetupWizard.tsx";
import { SlashOverlay } from "./overlays/Slash.tsx";
import { ThemesOverlay } from "./overlays/Themes.tsx";
import { SpanDetailsOverlay, TraceOverlay } from "./overlays/TraceView.tsx";
import { AuthScreen } from "./screens/Auth.tsx";
import { ConfigScreen } from "./screens/Config.tsx";
import { CredentialsScreen } from "./screens/Credentials.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { DoctorScreen } from "./screens/Doctor.tsx";
import { LogsScreen } from "./screens/Logs.tsx";
import { LlmScreen } from "./screens/Llm.tsx";
import { mcpRowCount, McpScreen } from "./screens/Mcp.tsx";
import { ProfilesScreen } from "./screens/Profiles.tsx";
import { ProxyScreen, type RouteDetailInfo } from "./screens/Proxy.tsx";
import { ServiceDetail } from "./screens/ServiceDetail.tsx";
import { ServicesScreen } from "./screens/Services.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SetupScreen } from "./screens/Setup.tsx";
import { StatsScreen } from "./screens/Stats.tsx";
import { TopologyScreen } from "./screens/Topology.tsx";
import { buildTopology } from "./helpers/topology.ts";
import { TokensScreen } from "./screens/Tokens.tsx";
import { uiScaleFor } from "./settings.ts";
import { THEME_NAMES } from "./themes.ts";
import { defaultCopyKeybind, type TuiConfig } from "./tui-config.ts";
import { type ConfirmDetail, type ConfirmKind, type Overlay, type Screen, type SlashPicker } from "./types.ts";
import { type TuiWorkspace } from "./workspace.ts";

type AppProps = {
  controller?: Controller;
  tui: TuiConfig;
  onQuit: (detach?: boolean) => void;
  onDown?: (keepServices: boolean) => void;
  onAttached?: (controller: Controller) => void;
  bootError?: string;
  bootErrorMissing?: boolean;
  terminalBackground?: string | null;
  workspace: TuiWorkspace;
};

export function App({ controller: initialController, tui, onQuit, onDown, onAttached, bootError: initialBootError, bootErrorMissing = false, terminalBackground, workspace }: AppProps) {
  const {
    saveTuiPreferences,
    resolveTuiOverridePath,
    userTuiConfigPath,
    validateConfigText,
    freePort,
    readTextFile,
    writeTextFile,
    createStarterConfig,
    validate,
  } = workspace;
  const [controller, setController] = useState(initialController);
  const [bootError, setBootError] = useState(initialBootError);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [screen, setScreen] = useState<Screen>(controller ? "dashboard" : "setup");
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [query, setQuery] = useState("");
  const [slashPicker, setSlashPicker] = useState<SlashPicker>("commands");
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
  const [traceDetail, setTraceDetail] = useState<TraceResponse | undefined>();
  const [traceSpanIndex, setTraceSpanIndex] = useState(0);
  const [routeDetail, setRouteDetail] = useState<RouteDetailInfo | undefined>();
  const [scrollText, setScrollText] = useState<{ title: string; body: string } | undefined>();
  const configScrollRef = useRef<ScrollBoxRenderable>(null);
  const helpScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const logDetailsScrollRef = useRef<ScrollBoxRenderable>(null);
  const traceScrollRef = useRef<ScrollBoxRenderable>(null);
  const traceDetailScrollRef = useRef<ScrollBoxRenderable>(null);
  const routeDetailsScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollTextScrollRef = useRef<ScrollBoxRenderable>(null);
  const planScrollRef = useRef<ScrollBoxRenderable>(null);
  const lastExportPath = useRef("");
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>("quit");
  const [envIndex, setEnvIndex] = useState(0);
  const [envPickerService, setEnvPickerService] = useState("");
  const leaderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interruptArmedAt = useRef(0);
  const openRequestGeneration = useRef(0);

  const [cfg, setCfg] = useState<DevctlConfig | undefined>(controller?.cfg);
  const leftover = controller?.previousPersisted;
  // Persists across reloads until the next successful one supersedes it —
  // unlike `status`, which is a transient one-line message for the last
  // action, this is state the user needs to keep seeing.
  const [configReloadError, setConfigReloadError] = useState<string | undefined>(undefined);
  const preferences = usePreferences({
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
  const {
    themeName,
    setThemeName,
    fontSize,
    prefsLocked,
    palette,
    rootBackground,
    settingRows,
    persistPrefs,
    persistTheme,
    activateSetting,
  } = preferences;
  const notifications = useNotifications({
    checkUpdate: workspace.checkUpdate,
    dismissed: tui.dismissed_notifications ?? [],
    prefsLocked,
    saveTuiPreferences,
    setStatus,
  });

  const diagnostics = useDiagnostics({ controller, workspace, cfg, snap, screen, configReloadError, setSnap, setStatus });
  const { google, doctor, doctorLoading, doctorError, doctorProgress, setDoctorTick } = diagnostics;
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
  const llmView = useLlmView({ controller, screen });
  const {
    logs,
    setLogs,
    paused,
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
    logServiceB,
    setLogServiceB,
    splitLogs,
    splitFocus,
    setSplitFocus,
    logSliceB,
    logWindowB,
    logSelectedB,
    logPinnedB,
    pinLogViewB,
    logServices,
    logShowTimestamps,
    logShowMeta,
    logSource,
    logRegex,
    logWrap,
    logPinned,
    logSelected,
    logsFullscreen,
    dashboardLogCursor,
    setDashboardLogCursor,
    logFacets,
    logSources,
    filteredLogs,
    filteredLogsB,
    logWindow,
    logSlice,
    pinLogView,
    applyLogCursorA,
    applyLogCursorB,
    jumpToLatestLogs,
  } = logView;

  const filtered = useMemo(() => {
    if (slashPicker === "tasks") {
      return namedPickerItems(Object.keys(cfg?.tasks ?? {}), query, "tasks", "run this task");
    }
    if (slashPicker === "services") {
      return namedPickerItems(Object.keys(cfg?.services ?? {}), query, "services", "exec in this service");
    }
    return paletteOptions(query, {
      services: Object.keys(cfg?.services ?? {}),
      tasks: Object.keys(cfg?.tasks ?? {}),
    });
  }, [cfg, query, slashPicker]);

  useEffect(() => {
    setSlashIndex(0);
  }, [query]);

  // Dependency graph for the topology screen. Computed once here so the screen's
  // node ordering and the Enter handler (topologyNodes below) stay in lockstep.
  const topologyModel = useMemo(() => (cfg ? buildTopology(cfg, profile) : { columns: [], edges: [], cyclic: false }), [cfg, profile]);
  const listCount = screenListCount(screen, {
    doctor: doctor?.checks.length ?? 0,
    settings: settingRows.length,
    profiles: Object.keys(cfg?.profiles ?? {}).length,
    services: names.length,
    logs: splitLogs && splitFocus === 1 ? logSliceB.length : logSlice.length,
    mcp: mcpRowCount(),
    config: Object.keys(cfg?.tasks ?? {}).length,
    llm: llmView.page.calls.length,
  });
  const cursorState = screen === "logs" ? (splitLogs && splitFocus === 1 ? logSelectedB : logSelected) : selected;
  const listCursor = listCount <= 0 ? Math.max(0, cursorState) : Math.max(0, Math.min(cursorState, listCount - 1));
  const envService = screen === "detail" ? detailName : screen === "services" ? (names[listCursor] ?? "") : "";
  const inspectorEnvName = snap?.services[envService]?.env ?? "";
  const { inspectorEnv, inspectorEnvStatus, inspectorEnvError, resolveEnvironment } = useServiceEnvironment({ controller, cfg, envService, envName: inspectorEnvName });
  const traceRows = useMemo(() => (traceDetail ? orderTraceRows(traceDetail.tree) : []), [traceDetail]);
  const activeTraceSpan = traceRows[clampTraceSpanIndex(traceSpanIndex, traceRows.length)]?.span;
  // Match the open trace back to its proxy request so the trace overlay can name
  // the hop (route, identity, status). Falls back to matching on trace id.
  const traceRequestContext = useMemo(() => {
    if (!traceDetail) {
      return undefined;
    }
    const req = matchProxyRequest(snap?.proxy.recentRequests ?? [], {
      requestId: traceDetail.requestId,
      traceId: traceDetail.tree.traceId,
    });
    if (!req) {
      return undefined;
    }
    return { requestId: req.requestId, route: req.route, identity: req.identity, status: req.status, method: req.method };
  }, [traceDetail, snap]);
  const closeOverlay = useCallback(() => {
    setOverlay("none");
    setQuery("");
    setSlashPicker("commands");
    setLogSearchFocused(false);
    if (leaderTimer.current) {
      clearTimeout(leaderTimer.current);
    }
  }, []);

  const toggleChecked = useCallback((name: string) => {
    setChecked((cur) => (cur.includes(name) ? cur.filter((svc) => svc !== name) : [...cur, name]));
  }, []);

  const mcp = useMcpControls({
    tui,
    controller,
    cfg,
    persistPrefs,
    snap,
    refresh,
    setStatus,
  });
  const {
    mcpPortDraft,
    mcpPort,
    toggleMcpTool,
    toggleMcp,
    copyMcpSnippet,
  } = mcp;

  useDaemonEvents({ controller, cfg, paused, logSince, refresh, setLogs, setCfg, setConfigReloadError, setStatus });

  const openDetail = useCallback((name: string) => {
    setDetailName(name);
    setScreen("detail");
  }, []);

  const focusedServiceName = screen === "detail" ? detailName : (names[listCursor] ?? "");
  const envOptions = useMemo(() => {
    const svc = cfg?.services[envPickerService];
    if (!svc) {
      return [];
    }
    return serviceEnvOptions(svc, snap?.services[envPickerService]);
  }, [cfg, envPickerService, snap]);

  const applyEnv = useCallback((service: string, name: string, opts?: { restart?: boolean; confirmed?: boolean }) => {
    if (!controller) {
      setStatus("no daemon attached");
      return;
    }
    if (service === "") {
      setStatus("pick a service first");
      return;
    }
    const svc = cfg?.services[service];
    const rt = snap?.services[service];
    if (!opts?.confirmed && !opts?.restart && svc && shouldConfirmEnvSwitch(svc, rt, name)) {
      setConfirmDetail({ services: [service], env: name });
      setConfirmKind("env-restart");
      setOverlay("confirm");
      return;
    }
    const restart = opts?.restart === true;
    void controller.setServiceEnvironment(service, name).then(async (result) => {
      closeOverlay();
      if (restart) {
        await controller.restart([service]);
      }
      const next = await refresh();
      const live = next?.services[service];
      const note = !restart && live?.pid && live.started_env !== result.env ? " · restart to apply" : "";
      setStatus(`${result.service}: ${result.env}${note}`);
    }).catch((err: unknown) => {
      setStatus(humanMessage(err));
    });
  }, [cfg, closeOverlay, controller, refresh, snap]);

  const openEnvPicker = useCallback((service?: string) => {
    const target = service && service !== "" ? service : focusedServiceName;
    if (target === "") {
      setStatus("pick a service first");
      return;
    }
    const svc = cfg?.services[target];
    if (!svc) {
      setStatus(`unknown service ${target}`);
      return;
    }
    if (!serviceHasNamedEnvironments(svc)) {
      setStatus(`${target} has no named environments`);
      return;
    }
    const options = serviceEnvOptions(svc, snap?.services[target]);
    const current = options.findIndex((option) => option.current);
    setEnvPickerService(target);
    setEnvIndex(Math.max(0, current));
    setOverlay("env");
  }, [cfg, focusedServiceName, snap]);

  const openTrace = useCallback((traceId: string) => {
    if (traceId === "" || !controller) {
      return;
    }
    void controller.getTrace(traceId).then((result) => {
      setTraceSpanIndex(0);
      setTraceDetail(result);
      setOverlay("trace");
    }).catch((err: unknown) => {
      setStatus(humanMessage(err));
    });
  }, [controller]);

  // Follow one request across every view: seed the logs filter with its id so
  // backing out of the trace lands on the request's logs, then resolve and open
  // its trace. If no trace exists yet, drop to the pre-filtered logs screen.
  const openRequest = useCallback((requestId: string) => {
    const id = requestId.trim();
    if (id === "" || !controller) {
      return;
    }
    const generation = ++openRequestGeneration.current;
    setLogSearch(id);
    void controller.traceRequest(id).then((result) => {
      if (generation !== openRequestGeneration.current) {
        return;
      }
      setTraceSpanIndex(0);
      setTraceDetail(result);
      // Backing out of the overlay should land on this request's filtered logs,
      // including when the follow started from proxy or log-details.
      setScreen("logs");
      setOverlay("trace");
    }).catch(() => {
      if (generation !== openRequestGeneration.current) {
        return;
      }
      // No trace yet — close any overlay (e.g. log-details) so the pre-filtered
      // logs screen is actually visible, then drop to it.
      setOverlay("none");
      setScreen("logs");
      setStatus(`tracing ${id}`);
    });
  }, [controller, setLogSearch]);

  const openSpanLogs = useCallback((index?: number) => {
    if (index !== undefined) {
      setTraceSpanIndex(index);
    }
    setOverlay("span-details");
  }, []);

  const openEnvDetail = useCallback((entry: ServiceEnvEntry) => {
    const body = entry.value !== "" ? entry.value : entry.required ? "(required, not set)" : "(empty)";
    setScrollText({ title: entry.key, body });
    setOverlay("scroll-text");
  }, []);

  const lifecycleActions = useLifecycle({ controller, workspace, cfg, snap, refresh, setStatus, setOverlay });
  const { plan, planInitiallyRunning, planBusy, lifecycle } = lifecycleActions;
  const wizard = useSetupWizard({
    workspace,
    renderer,
    setOverlay,
    setStatus,
    setScreen,
    onAttached,
    setController,
    setCfg,
    setBootError,
  });

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

  const copySelection = useCallback(async () => {
    const text = renderer.getSelection()?.getSelectedText() ?? "";
    if (text.trim() === "") {
      setStatus("Nothing selected — drag to highlight text");
      return;
    }
    try {
      await writeClipboard(text);
      const lines = text.split("\n").length;
      setStatus(lines === 1 ? "Copied selection" : `Copied ${lines} selected lines`);
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [renderer]);

  const {
    runCommand,
  } = useCommandDispatcher({
    setOverlay,
    setQuery,
    setSlashPicker,
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
    openEnvPicker,
    applyEnv,
    openDetail,
    copySelection,
    lastExportPath,
    openConfigBuffer,
    onDown: onDown ?? ((keep) => onQuit(keep)),
    onNotifyAction: (action) => {
      if (action === "later") {
        notifications.later();
        return;
      }
      notifications.dismiss();
    },
    onUpdateCheck: notifications.applyCheck,
    onUpdateApplied: notifications.hideCurrent,
    workspace,
    logView,
    llmView,
    diagnostics,
    lifecycleActions,
  });

  const submitSlash = useCallback(() => {
    const spec = selectedSlashCommand(filtered, slashIndex);
    if (slashPicker === "tasks") {
      if (!spec) {
        setStatus(filtered.length === 0 ? "no tasks configured" : "pick a task");
        return;
      }
      setSlashPicker("commands");
      const run = lookupCommand("run");
      if (run) {
        void runCommand(run, [spec.name]);
      }
      return;
    }
    if (slashPicker === "services") {
      if (!spec) {
        setStatus(filtered.length === 0 ? "no services configured" : "pick a service");
        return;
      }
      setSlashPicker("commands");
      setQuery(`exec ${spec.name} -- `);
      return;
    }
    if (!spec) {
      setStatus(query.trim() === "" ? "pick a command from the list" : `unknown command /${query}`);
      closeOverlay();
      return;
    }
    void runCommand(spec, slashSubmitArgs(spec, query));
  }, [closeOverlay, filtered, query, runCommand, slashIndex, slashPicker]);

  const applyTheme = useCallback(
    (name: string) => {
      persistTheme(name);
      closeOverlay();
    },
    [closeOverlay, persistTheme],
  );

  useAppKeyboard({
    tui,
    controller,
    cfg,
    snap,
    ui: {
      screen,
      overlay,
      onQuit,
      onDown: onDown ?? ((keep) => onQuit(keep)),
      closeOverlay,
      confirmKind,
      confirmDetail,
      portTarget,
      profile,
      listCursor,
      names,
      listCount,
      openDetail,
      copySelection,
      height,
      paletteIndex,
      applyTheme,
      runCommand,
      saveConfigBuffer,
      filtered,
      slashIndex,
      submitSlash,
      advanceWizard: () => void wizard.advanceWizard(),
      bootErrorMissing,
      bootError,
      createStarterConfig,
      startWizard: wizard.startWizard,
      toggleChecked,
      checked,
      detailName,
      refresh,
      openConfigBuffer,
      setOverlay,
      setConfirmKind,
      setConfirmDetail,
      setPortTarget,
      setLogDetail,
      logDetail,
      setLlmDetail: llmView.setDetail,
      llmDetail: llmView.detail,
      llmCalls: llmView.page.calls,
      toggleLlmBodyMode: llmView.toggleBodyMode,
      openTrace,
      openRequest,
      openSpanLogs,
      traceSpanCount: traceRows.length,
      setTraceSpanIndex,
      setLogSearch,
      setProfile,
      setStatus,
      setPaletteIndex,
      setSlashIndex,
      setQuery,
      setSlashPicker,
      setScreen,
      setSelected,
      setChecked,
      setConfigEditError,
      freePort,
      openEnvPicker,
      envOptions,
      envIndex,
      setEnvIndex,
      applyEnv: (name: string) => applyEnv(envPickerService, name),
      applyServiceEnv: applyEnv,
    },
    logView,
    lifecycleActions,
    mcp,
    preferences,
    diagnostics,
    refs: {
      interruptArmedAt,
      leaderTimer,
      logDetailsScrollRef,
      traceScrollRef,
      traceDetailScrollRef,
      scrollTextScrollRef,
      routeDetailsScrollRef,
      planScrollRef,
      helpScrollRef,
      configScrollRef,
      detailScrollRef,
    },
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
          <Header palette={palette} cfg={cfg} snap={snap} google={google} profile={profile} reveal={reveal} width={width} updateLatest={notifications.notice ? notifications.check?.latest : undefined} />
          <NavStrip palette={palette} screen={screen} width={width} onSelect={setScreen} />
          {notifications.notice ? (
            <NoticeBar
              palette={palette}
              notice={notifications.notice}
              width={width}
              onAction={(action) => {
                if (action === "primary") {
                  const spec = lookupCommand("update");
                  if (spec) {
                    void runCommand(spec, []);
                  }
                  return;
                }
                if (action === "later") {
                  notifications.later();
                  return;
                }
                notifications.dismiss();
              }}
            />
          ) : null}
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
            width={width}
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
            search={logSearch}
            regex={logRegex}
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
            errorOnly={errorOnly}
            showSystemLogs={showSystemLogs}
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
            selected={logSelected}
            follow={!logPinned}
            newer={logWindow.newer}
            viewStart={logWindow.start}
            viewTotal={filteredLogs.length}
            onSelect={applyLogCursorA}
            fullscreen={logsFullscreen}
            onLeaveLatest={pinLogView}
            onJumpLatest={jumpToLatestLogs}
            facets={logFacets}
            split={splitLogs}
            splitFocus={splitFocus}
            serviceB={logServiceB}
            viewB={logSliceB}
            selectedB={logSelectedB}
            followB={!logPinnedB}
            newerB={logWindowB.newer}
            viewStartB={logWindowB.start}
            viewTotalB={filteredLogsB.length}
            onServiceB={setLogServiceB}
            onSelectB={applyLogCursorB}
            onLeaveLatestB={pinLogViewB}
            onFocusPane={setSplitFocus}
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
            onOpenTrace={openTrace}
            onFollowRequest={openRequest}
          />
        ) : null}
        {screen === "llm" ? (
          <LlmScreen
            palette={palette}
            cfg={cfg}
            page={llmView.page}
            error={llmView.error}
            caller={llmView.caller}
            selected={listCursor}
            width={width}
            bodyMode={llmView.bodyMode}
            onToggleBody={llmView.toggleBodyMode}
            onPick={setSelected}
            onOpen={(call) => {
              llmView.setDetail(call);
              setOverlay("llm-details");
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
        {screen === "topology" ? <TopologyScreen palette={palette} model={topologyModel} snap={snap} width={width} selected={listCursor} onSelectIndex={setSelected} /> : null}
        {screen === "tokens" ? <TokensScreen palette={palette} credentials={snap?.credentials} logs={logs} width={width} /> : null}
        {screen === "config" ? <ConfigScreen palette={palette} cfg={cfg} width={width} selectedTask={listCursor} scrollRef={configScrollRef} /> : null}
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
          title={slashPicker === "tasks" ? "tasks" : slashPicker === "services" ? "services" : "commands"}
          onQuery={setQuery}
          onSubmit={submitSlash}
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
      {overlay === "env" ? (
        <EnvOverlay
          palette={palette}
          service={envPickerService}
          options={envOptions}
          selected={envIndex}
          termW={width}
          termH={height}
          onIndex={setEnvIndex}
          onPick={(name) => applyEnv(envPickerService, name)}
        />
      ) : null}
      {overlay === "help" ? (
        <HelpOverlay palette={palette} termW={width} termH={height} copyKey={copyKey} scrollRef={helpScrollRef} />
      ) : null}
      {overlay === "leader" ? <LeaderOverlay palette={palette} termW={width} termH={height} /> : null}
      {overlay === "confirm" ? (
        <ConfirmOverlay palette={palette} title={confirm.title} body={confirm.body} kind={confirmKind} termW={width} termH={height} />
      ) : null}
      {overlay === "setup-wizard" ? (
        <SetupWizardOverlay
          palette={palette}
          termW={width}
          termH={height}
          step={wizard.step}
          answers={wizard.answers}
          repo={wizard.repo}
          draft={wizard.draft}
          authStatus={wizard.authStatus}
          onDraft={wizard.setDraft}
          onSubmit={() => void wizard.advanceWizard()}
        />
      ) : null}
      {overlay === "log-details" ? (
        <LogDetailsOverlay palette={palette} event={logDetail} termW={width} termH={height} scrollRef={logDetailsScrollRef} onViewTrace={openTrace} />
      ) : null}
      {overlay === "llm-details" ? (
        <LlmDetailsOverlay palette={palette} call={llmView.detail} bodyMode={llmView.bodyMode} onToggleBody={llmView.toggleBodyMode} termW={width} termH={height} scrollRef={logDetailsScrollRef} onViewTrace={openTrace} />
      ) : null}
      {overlay === "trace" || overlay === "span-details" ? (
        <TraceOverlay palette={palette} trace={traceDetail?.tree} selected={traceSpanIndex} onSelect={setTraceSpanIndex} onOpenLogs={openSpanLogs} termW={width} termH={height} scrollRef={traceScrollRef} requestContext={traceRequestContext} />
      ) : null}
      {overlay === "span-details" ? (
        <SpanDetailsOverlay palette={palette} span={activeTraceSpan} records={traceDetail?.events} termW={width} termH={height} scrollRef={traceDetailScrollRef} />
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
          searchFocused={logSearchFocused}
          searchQuery={logSearch}
        />
      )}
    </box>
    </DensityContext.Provider>
  );
}
