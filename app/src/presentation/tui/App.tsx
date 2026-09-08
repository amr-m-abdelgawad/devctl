import { type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Controller } from "../../application/client-runtime.ts";
import type { DevctlConfig } from "../../domain/config/types.ts";
import type { LogEvent } from "../../domain/logs/logs.ts";
import type { PortHolder } from "../../domain/net/ports.ts";
import { humanMessage } from "../../shared/errors.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { CommandLine, Header, NavStrip, StatusBar } from "./chrome.tsx";
import { writeClipboard } from "./clipboard.ts";
import { allCommands, commandArgs, filterCommands, lookupCommand, type CommandSpec } from "./commands.ts";
import { DensityContext } from "./density.tsx";
import { compactChrome, confirmCopy } from "./helpers/chrome.ts";
import { paletteOptions, selectedSlashCommand } from "./helpers/command-catalog.ts";
import { formatLogDetails, formatLogsForClipboard } from "./helpers/logs.ts";
import { screenListCount } from "./helpers/navigation.ts";
import { defaultProfileName, type ServiceEnvEntry } from "./helpers/services.ts";
import { useAppKeyboard } from "./hooks/use-app-keyboard.ts";
import { useCommandDispatcher } from "./hooks/use-command-dispatcher.ts";
import { useConfigEditor } from "./hooks/use-config-editor.ts";
import { useDaemonEvents } from "./hooks/use-daemon-events.ts";
import { useDiagnostics } from "./hooks/use-diagnostics.ts";
import { useLifecycle } from "./hooks/use-lifecycle.ts";
import { useLogView } from "./hooks/use-log-view.ts";
import { useMcpControls } from "./hooks/use-mcp-controls.ts";
import { usePreferences } from "./hooks/use-preferences.ts";
import { useServiceEnvironment } from "./hooks/use-service-environment.ts";
import { ConfigEditOverlay } from "./overlays/ConfigEdit.tsx";
import { ConfirmOverlay } from "./overlays/Confirm.tsx";
import { HelpOverlay } from "./overlays/Help.tsx";
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
import { mcpRowCount, McpScreen } from "./screens/Mcp.tsx";
import { ProfilesScreen } from "./screens/Profiles.tsx";
import { ProxyScreen, type RouteDetailInfo } from "./screens/Proxy.tsx";
import { ServiceDetail } from "./screens/ServiceDetail.tsx";
import { ServicesScreen } from "./screens/Services.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SetupScreen } from "./screens/Setup.tsx";
import { StatsScreen } from "./screens/Stats.tsx";
import { uiScaleFor } from "./settings.ts";
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

  useAppKeyboard({
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
