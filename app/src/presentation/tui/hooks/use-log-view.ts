import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { LogEvent, LogFacets } from "../../../domain/logs/logs.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../types.ts";
import {
  filterLogs,
  INTERNAL_LOG_SERVICES,
  LOG_LIST_TAIL,
  logCursorStep,
  logFilterSources,
  logPinStart,
  logViewWindow,
  mergeLoadedPage,
  needsOlderLogPage,
  prependOlderPage,
  type LogWrapMode,
} from "../helpers/logs.ts";
import { type TuiConfig } from "../tui-config.ts";
import { type Screen } from "../types.ts";

const NO_LOG_SERVICES: string[] = [];
const FACETS_POLL_MS = 2000;
type Options = {
  controller?: Controller;
  tui: TuiConfig;
  names: string[];
  screen: Screen;
  refresh: () => Promise<StatusSnapshot | undefined>;
  setStatus: (status: string) => void;
};

export function useLogView({
  controller,
  tui,
  names,
  screen,
  refresh,
  setStatus,
}: Options) {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [errorOnly, setErrorOnly] = useState(false);
  const [showSystemLogs, setShowSystemLogs] = useState(true);
  const [logSearch, setLogSearch] = useState("");
  const [logSearchFocused, setLogSearchFocused] = useState(false);
  const [logFollow, setLogFollow] = useState(0);
  const [logSince, setLogSince] = useState("");
  const [logUntil, setLogUntil] = useState("");
  const [logService, setLogService] = useState("");
  const logServices = NO_LOG_SERVICES;
  const [logShowTimestamps, setLogShowTimestamps] = useState(tui.log_timestamps !== false);
  const [logShowMeta, setLogShowMeta] = useState(tui.log_metadata !== false);
  const [extraLogSources, setExtraLogSources] = useState<string[]>(() => [...INTERNAL_LOG_SERVICES]);
  const [logLevel] = useState("");
  const [logSource] = useState("");
  const [logRegex, setLogRegex] = useState(false);
  const [logWrap, setLogWrap] = useState<LogWrapMode>("focus");
  const [logPinned, setLogPinned] = useState(false);
  const [logSelected, setLogSelected] = useState(LOG_LIST_TAIL - 1);
  const [logsFullscreen, setLogsFullscreen] = useState(false);
  const [dashboardLogCursor, setDashboardLogCursor] = useState(-1);
  const [logFacets, setLogFacets] = useState<LogFacets | undefined>();
  const [logPrevCursor, setLogPrevCursor] = useState("");
  const [logHasPrevPage, setLogHasPrevPage] = useState(false);
  const [loadingOlderLogs, setLoadingOlderLogs] = useState(false);
  const logsRef = useRef<LogEvent[]>([]);
  const [logViewStart, setLogViewStart] = useState(0);
  const logSources = useMemo(() => logFilterSources(names, logs, extraLogSources), [names, logs, extraLogSources]);
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
        until: logUntil,
        systemLogs: showSystemLogs,
      }),
    [errorOnly, logRegex, logSearch, logService, logServices, logSince, logSource, logUntil, logs, showSystemLogs],
  );
  const logWindow = useMemo(
    () => logViewWindow(filteredLogs, logPinned, logViewStart),
    [filteredLogs, logPinned, logViewStart],
  );
  const logSlice = logWindow.items;
  useEffect(() => {
    setDashboardLogCursor(-1);
    setLogPinned(false);
    setLogSelected(Math.max(0, Math.min(LOG_LIST_TAIL, filteredLogs.length) - 1));
  }, [errorOnly, logSearch, logService, showSystemLogs]);

  useEffect(() => {
    if (screen !== "logs") {
      setLogsFullscreen(false);
    }
  }, [screen]);

  useEffect(() => {
    if (screen !== "logs" || logPinned) {
      return;
    }
    setLogSelected(Math.max(0, Math.min(LOG_LIST_TAIL, filteredLogs.length) - 1));
  }, [filteredLogs.length, logPinned, screen]);

  const pinLogView = useCallback(() => {
    if (!logPinned) {
      setLogViewStart(logPinStart(filteredLogs.length));
      setLogPinned(true);
    }
  }, [filteredLogs.length, logPinned]);

  const applyLogCursor = useCallback(
    (next: number) => {
      const step = logCursorStep(next, logSlice.length, logWindow.start, logWindow.newer);
      if (step.startDelta !== 0) {
        setLogViewStart(Math.max(0, logWindow.start + step.startDelta));
        setLogPinned(true);
        setLogSelected(step.selected);
        return;
      }
      const last = Math.max(logSlice.length - 1, 0);
      const leaveLatest = logSlice.length > 0 && (step.selected < last || logWindow.newer > 0);
      if (leaveLatest && !logPinned) {
        setLogViewStart(logPinStart(filteredLogs.length));
        setLogPinned(true);
      } else if (!leaveLatest) {
        setLogPinned(false);
      }
      setLogSelected(step.selected);
    },
    [filteredLogs.length, logSlice.length, logPinned, logWindow.newer, logWindow.start],
  );

  const applyDashboardLogCursor = useCallback(
    (next: number) => {
      const count = logSlice.length;
      const step = logCursorStep(next, count, logWindow.start, logWindow.newer);
      if (step.startDelta !== 0) {
        setLogViewStart(Math.max(0, logWindow.start + step.startDelta));
        setLogPinned(true);
      }
      setDashboardLogCursor(step.selected);
    },
    [logSlice.length, logWindow.newer, logWindow.start],
  );

  const jumpToLatestLogs = useCallback(() => {
    setLogPinned(false);
    setDashboardLogCursor(-1);
    if (screen === "logs") {
      setLogSelected(Math.max(0, Math.min(LOG_LIST_TAIL, filteredLogs.length) - 1));
    }
    setLogFollow((tick) => tick + 1);
    setStatus(logWindow.newer > 0 ? `Jumped to latest (+${logWindow.newer} new)` : "Jumped to latest logs");
  }, [filteredLogs.length, logWindow.newer, screen]);

  const currentLogFilter = useMemo(
    () => ({
      services: logService !== "" ? [logService] : logServices,
      level: errorOnly ? "ERROR" : logLevel,
      search: logSearch,
      regex: logRegex,
      source: logSource,
      since: logSince,
      until: logUntil,
    }),
    [errorOnly, logLevel, logRegex, logSearch, logService, logServices, logSince, logSource, logUntil],
  );

  // Deliberately lightweight (no event payload) — safe to poll on a timer
  // and after every filter change without re-transferring events already
  // held locally.
  const refreshFacets = useCallback(async () => {
    if (!controller) {
      return;
    }
    try {
      setLogFacets(await controller.logsStats(currentLogFilter));
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, currentLogFilter]);

  const refreshLogs = useCallback(async () => {
    if (!controller || paused) {
      return;
    }
    try {
      const page = await controller.logsPage(currentLogFilter);
      setLogs((current) => mergeLoadedPage(current, page.events));
      setLogPrevCursor(page.prevCursor);
      setLogHasPrevPage(page.hasPrev);
      await refreshFacets();
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, currentLogFilter, paused, refreshFacets]);

  // Client-local: hides everything up to now from this view via logSince,
  // without touching the daemon's shared log buffer — other attached
  // clients (another TUI session, the CLI, MCP) keep their own history.
  const clearLogs = useCallback(() => {
    setLogs([]);
    setLogSince(new Date().toISOString());
    setLogPinned(false);
    setStatus("Cleared on-screen log buffer");
  }, []);

  const toggleSystemLogs = useCallback(() => {
    setShowSystemLogs((v) => !v);
  }, []);

  useEffect(() => {
    void refresh().then(() => refreshLogs());
  }, [refresh, refreshLogs]);

  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);

  // Fetch older pages only while scrolling: the user has paged all the way
  // back to the top of what's currently loaded, and the server has more
  // history for the active filter. Sequence-based cursors make this safe to
  // interleave with events still streaming in live (see mergeLoadedPage).
  useEffect(() => {
    if (!controller || loadingOlderLogs || !needsOlderLogPage(logPinned, logWindow.start, logHasPrevPage)) {
      return;
    }
    setLoadingOlderLogs(true);
    void controller
      .logsPage({ ...currentLogFilter, cursor: logPrevCursor, direction: "backward" })
      .then((older) => {
        if (older.sessionChanged) {
          setStatus("Daemon session changed — older log history is no longer available");
          setLogHasPrevPage(false);
          return;
        }
        const before = logsRef.current;
        const merged = prependOlderPage(before, older.events);
        setLogs(merged);
        if (merged.length > before.length) {
          setLogViewStart((start) => start + (merged.length - before.length));
        }
        setLogPrevCursor(older.prevCursor);
        setLogHasPrevPage(older.hasPrev);
      })
      .catch((err: unknown) => setStatus(humanMessage(err)))
      .finally(() => setLoadingOlderLogs(false));
  }, [controller, currentLogFilter, loadingOlderLogs, logHasPrevPage, logPinned, logPrevCursor, logWindow.start]);

  // Facets are cheap (no event payload) so they can be kept live on a timer
  // while the logs screen is actively tailing, on top of the immediate
  // refresh already triggered by refreshLogs on every filter change/clear.
  useEffect(() => {
    if (!controller || paused || screen !== "logs") {
      return;
    }
    const id = setInterval(() => {
      void refreshFacets();
    }, FACETS_POLL_MS);
    return () => clearInterval(id);
  }, [controller, paused, refreshFacets, screen]);

  return {
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
    setLogSince,
    setLogUntil,
    logService,
    setLogService,
    logServices,
    logShowTimestamps,
    setLogShowTimestamps,
    logShowMeta,
    setLogShowMeta,
    logLevel,
    logSource,
    logRegex,
    setLogRegex,
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
  };
}
