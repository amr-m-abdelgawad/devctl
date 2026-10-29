import { SystemPage } from "./pages/system.tsx";
import { applyWebTheme } from "./theme.ts";
import { PageBoundary } from "./components/page-boundary.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconContext } from "./icons.ts";
import { ConsoleShell } from "./components/shell.tsx";
import { ServiceDetail } from "./components/service-detail.tsx";
import { ConfigPage } from "./pages/config.tsx";
import { ProxyPage } from "./pages/proxy.tsx";
import { WorkspacePage } from "./pages/workspace.tsx";
import { useInspectorFeed } from "./hooks/use-inspector-feed.ts";
import { serviceIsHealthy } from "./fleet.ts";
import {
  fetchConfig,
  fetchLlmCall,
  fetchLlmCalls,
  fetchLogs,
  fetchPreferences,
  fetchProfiles,
  fetchRequestTrace,
  fetchRequests,
  fetchServices,
  fetchStatus,
  fetchTrace,
  fetchTrafficCall,
  fetchTrafficCalls,
  fetchUpdate,
  postControl,
} from "./api.ts";
import { percentile, type SeriesPoint } from "./charts.tsx";
import { ControlNotice } from "./components/controls.tsx";
import { UpdateNotice } from "./components/update-notice.tsx";
import { noticeFor, type RunControl } from "./control.ts";
import { NANOS_PER_MS, traceEnvelopeNs } from "./format.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { activeInspectId, hrefFor, parseHash } from "./hash.ts";
import { advanceRingCounter, emptyRingCounter, lifetimeTotal, logLifetime } from "./lifetime.ts";
import { counterWindowRate, rateInWindow, requestIsFailure } from "./rates.ts";
import { OverviewPage, type OverviewSummary } from "./pages/overview.tsx";
import { GraphPage } from "./pages/graph.tsx";
import { LogsPage } from "./pages/logs.tsx";
import { DoctorPage } from "./pages/doctor.tsx";
import { IdentityPage } from "./pages/identity.tsx";
import { LlmPage } from "./pages/llm.tsx";
import { TrafficPage } from "./pages/traffic.tsx";
import { TracesPage } from "./pages/traces.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import type {
  ConfigSummary,
  ControlArgs,
  ControlTool,
  LlmCallRow,
  LogRow,
  ProfileRow,
  RequestsPayload,
  Route,
  RouteName,
  ServiceRow,
  StatusSummary,
  TracePayload,
  TrafficCallRow,
  UpdateCheckPayload,
} from "./types.ts";
import {
  DISMISSED_NOTIFICATIONS_KEY,
  isUpdateNoticeVisible,
  readIdList,
  SESSION_HIDDEN_NOTIFICATIONS_KEY,
  withDismissed,
  writeIdList,
} from "./notifications.ts";
import { consoleDocumentTitle, repoDisplayName } from "./title.ts";

const POLL_MS = 2000;
const WINDOW = 60;
const RATE_LOOKBACK_MS = 10_000;
const PAGE_LABEL: Record<RouteName, string> = {
  services: "Overview",
  traces: "Traces",
  llm: "LLM",
  traffic: "Traffic",
  graph: "Graph",
  logs: "Logs",
  doctor: "Doctor",
  identity: "Identity",
  settings: "Settings",
  workspace: "Profiles & tasks",
  config: "Configuration",
  proxy: "Proxy & connections",
  system: "System & supervisor",
};

type RateSample = {
  t: number;
  reqs: number;
  reqFails: number;
  logs: number;
  logFails: number;
  seen: number;
  seenErrors: number;
  p50: number;
  p95: number;
};

function readRoute(): Route {
  return parseHash(window.location.hash);
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onHash = (): void => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) {
      window.location.hash = "#/services";
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const [status, setStatus] = useState<StatusSummary | undefined>(undefined);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [requests, setRequests] = useState<RequestsPayload | undefined>(undefined);
  const [config, setConfig] = useState<ConfigSummary | undefined>(undefined);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [errors, setErrors] = useState<LogRow[]>([]);
  const [llmDetail, setLlmDetail] = useState<LlmCallRow | undefined>(undefined);
  const [llmError, setLlmError] = useState("");
  // Active caller filter ("" = all, "-" = no caller) and the option list. The
  // options are refreshed only on an unfiltered poll so selecting one caller
  // never collapses the list to just that caller.
  const [llmCaller, setLlmCaller] = useState("");
  const [llmCallers, setLlmCallers] = useState<string[]>([]);
  const [llmSearch, setLlmSearch] = useState("");
  const [trafficDetail, setTrafficDetail] = useState<TrafficCallRow | undefined>(undefined);
  const [trafficError, setTrafficError] = useState("");
  const [trafficSearch, setTrafficSearch] = useState("");
  const [trafficCaller, setTrafficCaller] = useState("");
  const [trafficCallers, setTrafficCallers] = useState<string[]>([]);
  const [llmFilters, setLlmFilters] = useState<Record<string, string>>({});
  const [trafficFilters, setTrafficFilters] = useState<Record<string, string>>({});
  const llmParams = useMemo(() => ({ ...llmFilters, caller: llmCaller, search: llmSearch }), [llmFilters, llmCaller, llmSearch]);
  const trafficParams = useMemo(
    () => ({ ...trafficFilters, caller: trafficCaller, search: trafficSearch }),
    [trafficFilters, trafficCaller, trafficSearch],
  );
  const llmFeed = useInspectorFeed(route.name === "llm", fetchLlmCalls, llmParams);
  const trafficFeed = useInspectorFeed(route.name === "traffic", fetchTrafficCalls, trafficParams);
  const llmCalls = llmFeed.payload;
  const trafficCalls = trafficFeed.payload;
  const [llmModels, setLlmModels] = useState<string[]>([]);
  useEffect(() => {
    if (llmCalls && !llmCaller && !llmSearch && !Object.values(llmFilters).some(Boolean)) {
      setLlmCallers([...new Set(llmCalls.calls.map((row) => row.caller || "").filter(Boolean))].sort());
      setLlmModels([...new Set(llmCalls.calls.map((row) => row.model).filter(Boolean))].sort());
    }
  }, [llmCalls, llmCaller, llmSearch, llmFilters]);
  useEffect(() => {
    if (trafficCalls && !trafficCaller && !trafficSearch && !Object.values(trafficFilters).some(Boolean)) {
      setTrafficCallers([...new Set(trafficCalls.calls.map((row) => row.caller || "").filter(Boolean))].sort());
    }
  }, [trafficCalls, trafficCaller, trafficSearch, trafficFilters]);
  const [trace, setTrace] = useState<TracePayload | undefined>(undefined);
  const [traceError, setTraceError] = useState("");
  const [selectedSpan, setSelectedSpan] = useState("");
  const [pollError, setPollError] = useState("");
  const [rates, setRates] = useState<RateSample[]>([]);
  const [traceMsById, setTraceMsById] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const reportNotice = useCallback((message: string, error = false) => {
    setNotice(message);
    setNoticeError(error);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), noticeError ? 12000 : 6500);
    return () => window.clearTimeout(timer);
  }, [notice, noticeError]);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckPayload | undefined>(undefined);
  const [dismissedNotices, setDismissedNotices] = useState<string[]>(() => readIdList(window.localStorage, DISMISSED_NOTIFICATIONS_KEY));
  const [sessionHiddenNotices, setSessionHiddenNotices] = useState<string[]>(() =>
    readIdList(window.sessionStorage, SESSION_HIDDEN_NOTIFICATIONS_KEY),
  );
  const busyRef = useRef(false);
  const traceMsRef = useRef<Record<string, number>>({});
  const requestLifeRef = useRef(emptyRingCounter());
  const pollGenRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    void fetchUpdate()
      .then((payload) => {
        if (!cancelled) {
          setUpdateCheck(payload);
        }
      })
      .catch(() => {
        // A failed GitHub probe must not interrupt the console.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const refresh = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const prefs = await fetchPreferences();
        if (!cancelled) applyWebTheme(prefs.values.theme, prefs.values.web_appearance);
      } catch {
        /* Retain the last applied theme when preferences are unavailable. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    traceMsRef.current = traceMsById;
  }, [traceMsById]);
  useEffect(() => {
    const page = PAGE_LABEL[route.name];
    document.title = consoleDocumentTitle(page, repoDisplayName(config?.project, status?.repo_root));
  }, [route.name, config?.project, status?.repo_root]);

  const poll = useCallback(async () => {
    const gen = pollGenRef.current + 1;
    pollGenRef.current = gen;
    const [nextStatus, nextServices, nextRequests, nextConfig, nextErrors, nextProfiles] = await Promise.all([
      fetchStatus(),
      fetchServices(),
      fetchRequests(),
      fetchConfig(),
      fetchLogs({ level: "ERROR" }),
      fetchProfiles(),
    ]);
    if (gen !== pollGenRef.current) {
      return;
    }
    requestLifeRef.current = advanceRingCounter(
      requestLifeRef.current,
      (nextRequests.requests ?? []).map((row) => row.request_id),
    );
    setStatus(nextStatus);
    setServices(nextServices);
    setRequests(nextRequests);
    setConfig(nextConfig);
    setErrors(nextErrors.events);
    setProfiles(nextProfiles);
    setPollError("");
    const nowMs = Date.now();
    const rows = nextRequests.requests ?? [];
    const lat = rows.map((row) => row.duration_ms);
    const reqs = rateInWindow(
      rows.map((row) => row.timestamp),
      nowMs,
      RATE_LOOKBACK_MS,
    );
    const reqFails = rateInWindow(
      rows.filter((row) => requestIsFailure(row)).map((row) => row.timestamp),
      nowMs,
      RATE_LOOKBACK_MS,
    );
    const counts = logLifetime(nextStatus.logs);
    const nowSec = nowMs / 1000;
    const lookbackSec = RATE_LOOKBACK_MS / 1000;
    setRates((cur) => {
      const sample: RateSample = {
        t: nowSec,
        reqs,
        reqFails,
        logs: counterWindowRate(
          cur.map((row) => ({ t: row.t, value: row.seen })),
          nowSec,
          counts.total,
          lookbackSec,
        ),
        logFails: counterWindowRate(
          cur.map((row) => ({ t: row.t, value: row.seenErrors })),
          nowSec,
          counts.errors,
          lookbackSec,
        ),
        seen: counts.total,
        seenErrors: counts.errors,
        p50: percentile(lat, 50),
        p95: percentile(lat, 95),
      };
      return [...cur, sample].slice(-WINDOW);
    });
    setTraceMsById((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const row of nextRequests.requests ?? []) {
        if (row.trace_id && row.trace_duration_ms !== undefined && next[row.trace_id] !== row.trace_duration_ms) {
          next[row.trace_id] = row.trace_duration_ms;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, []);

  const runControl: RunControl = useCallback(
    (tool: ControlTool, args: ControlArgs = {}, label?: string) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setBusy(label || tool);
      reportNotice("");
      void (async () => {
        try {
          const result = await postControl(tool, args);
          reportNotice(noticeFor(tool, result, args));
          await poll().catch((err: unknown) => setPollError(err instanceof Error ? err.message : "Unable to refresh status"));
        } catch (err: unknown) {
          reportNotice(err instanceof Error ? err.message : "Control failed", true);
        } finally {
          busyRef.current = false;
          setBusy("");
        }
      })();
    },
    [poll, reportNotice],
  );

  useEffect(() => {
    const refresh = () => {
      void poll().catch(() => {});
    };
    window.addEventListener("devctl:refresh", refresh);
    return () => window.removeEventListener("devctl:refresh", refresh);
  }, [poll]);

  const externalBusy = useCallback(
    (label: string) => {
      busyRef.current = Boolean(label);
      setBusy(label);
      if (!label) void poll().catch(() => {});
    },
    [poll],
  );

  useEffect(() => {
    const run = (): void => {
      const gen = pollGenRef.current + 1;
      void poll().catch((err: unknown) => {
        if (gen !== pollGenRef.current) {
          return;
        }
        setPollError(err instanceof Error ? err.message : "poll failed");
      });
    };
    run();
    const timer = window.setInterval(() => {
      if (!document.hidden) run();
    }, POLL_MS);
    return () => {
      pollGenRef.current += 1;
      window.clearInterval(timer);
    };
  }, [poll]);

  useEffect(() => {
    if (route.name !== "traces" || !route.traceId) {
      setTrace(undefined);
      setTraceError("");
      return;
    }
    const requested = route.traceId;
    setSelectedSpan("");
    setTrace(undefined);
    let cancelled = false;
    void fetchTrace(requested)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setTrace(payload);
        setTraceError("");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setTrace(undefined);
        setTraceError(err instanceof Error ? err.message : "trace failed");
      });
    return () => {
      cancelled = true;
    };
  }, [route.name, route.traceId]);

  const llmInspectId = route.name === "llm" ? activeInspectId(route.llmId, llmCalls?.calls[0]?.id) : undefined;
  const trafficInspectId = route.name === "traffic" ? activeInspectId(route.trafficId, trafficCalls?.calls[0]?.id) : undefined;

  useEffect(() => {
    if (route.name !== "llm") {
      setLlmDetail(undefined);
      setLlmError("");
      return;
    }
    if (!llmInspectId) {
      setLlmDetail(undefined);
      setLlmError("");
      return;
    }
    const requested = llmInspectId;
    let cancelled = false;
    const run = (): void => {
      void fetchLlmCall(requested)
        .then((payload) => {
          if (cancelled) {
            return;
          }
          setLlmDetail(payload);
          setLlmError("");
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          setLlmDetail(undefined);
          setLlmError(err instanceof Error ? err.message : "llm call failed");
        });
    };
    run();
    const timer = window.setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route.name, llmInspectId]);

  useEffect(() => {
    if (route.name !== "traffic") {
      setTrafficDetail(undefined);
      setTrafficError("");
      return;
    }
    if (!trafficInspectId) {
      setTrafficDetail(undefined);
      setTrafficError("");
      return;
    }
    const requested = trafficInspectId;
    let cancelled = false;
    const run = (): void => {
      void fetchTrafficCall(requested)
        .then((payload) => {
          if (cancelled) {
            return;
          }
          setTrafficDetail(payload);
          setTrafficError("");
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          setTrafficDetail(undefined);
          setTrafficError(err instanceof Error ? err.message : "traffic call failed");
        });
    };
    run();
    const timer = window.setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route.name, trafficInspectId]);

  useEffect(() => {
    if (!trace?.trace_id || trace.spans.length === 0) {
      return;
    }
    const ms = traceEnvelopeNs(trace.spans) / NANOS_PER_MS;
    setTraceMsById((cur) => (cur[trace.trace_id] === ms ? cur : { ...cur, [trace.trace_id]: ms }));
  }, [trace]);

  useEffect(() => {
    if (route.name !== "traces" || route.traceId) {
      return;
    }
    const ids = [...new Set((requests?.requests ?? []).map((row) => row.trace_id).filter((id): id is string => Boolean(id)))]
      .filter((id) => traceMsRef.current[id] === undefined)
      .slice(0, 12);
    if (ids.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const id of ids) {
        if (cancelled) {
          return;
        }
        try {
          const payload = await fetchTrace(id);
          const ms = payload.spans.length === 0 ? 0 : traceEnvelopeNs(payload.spans) / NANOS_PER_MS;
          if (!cancelled) {
            setTraceMsById((cur) => (cur[id] === ms ? cur : { ...cur, [id]: ms }));
          }
        } catch {
          // Trace may have aged out of the span store.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route.name, route.traceId, requests]);

  const requestPoints: SeriesPoint[] = rates.map((row) => ({ t: row.t, values: [row.reqs, row.reqFails] }));
  const logPoints: SeriesPoint[] = rates.map((row) => ({ t: row.t, values: [row.logs, row.logFails] }));
  const latPoints: SeriesPoint[] = rates.map((row) => ({ t: row.t, values: [row.p50, row.p95] }));
  const cpu = status?.stats_series?.cpu ?? [];
  const mem = status?.stats_series?.mem ?? [];
  const interval = (status?.stats_series?.interval_ms ?? 5000) / 1000;
  const now = Date.now() / 1000;
  const hostPoints: SeriesPoint[] = cpu.map((value, index) => ({
    t: now - (cpu.length - 1 - index) * interval,
    values: [value * 100, (mem[index] ?? 0) * 100],
  }));

  const logCounts = logLifetime(status?.logs);
  const reqTotal = lifetimeTotal(status?.proxy.requestTotal, requests?.total, requestLifeRef.current.seen);
  const failedRequests = lifetimeTotal(status?.proxy.requestErrors, requests?.errors);
  const logTotal = logCounts.total;
  const logErrors = logCounts.errors;
  const last = rates[rates.length - 1];
  const summary: OverviewSummary = {
    total: services.length,
    healthy: services.filter(serviceIsHealthy).length,
    requests: reqTotal,
    failedRequests,
    failedRate: reqTotal > 0 ? (failedRequests / reqTotal) * 100 : 0,
    failedPerSec: last?.reqFails ?? 0,
    logErrors,
    p95: last?.p95 ?? 0,
    reqPerSec: last?.reqs ?? 0,
  };
  const showUpdate = updateCheck !== undefined && isUpdateNoticeVisible(updateCheck, dismissedNotices, sessionHiddenNotices);
  const projectName = repoDisplayName(config?.project, status?.repo_root);

  return (
    <IconContext.Provider value={{ weight: "regular", color: "currentColor", size: 16 }}>
      <TooltipProvider delayDuration={200}>
        <ConsoleShell
          route={route.name}
          project={projectName}
          status={status}
          services={services}
          busy={Boolean(busy)}
          error={pollError}
          onReload={() => runControl("reload_config", {}, "Reloading configuration…")}
          notice={<ControlNotice busy={busy} notice={notice} error={noticeError} onDismiss={() => setNotice("")} />}
          update={
            showUpdate && updateCheck ? (
              <UpdateNotice
                check={updateCheck}
                onLater={() => {
                  const next = withDismissed(sessionHiddenNotices, updateCheck.latest);
                  setSessionHiddenNotices(next);
                  writeIdList(window.sessionStorage, SESSION_HIDDEN_NOTIFICATIONS_KEY, next);
                }}
                onDismiss={() => {
                  const next = withDismissed(dismissedNotices, updateCheck.latest);
                  setDismissedNotices(next);
                  writeIdList(window.localStorage, DISMISSED_NOTIFICATIONS_KEY, next);
                }}
              />
            ) : null
          }
        >
          <PageBoundary route={route.name}>
            {route.name === "services" ? (
              <OverviewPage
                summary={summary}
                services={services}
                requests={requests}
                errors={errors}
                profiles={profiles}
                tasks={config?.tasks ?? []}
                configServices={config?.services ?? []}
                profile={status?.profile || profiles[0]?.name || ""}
                busy={Boolean(busy)}
                traceMsById={traceMsById}
                onControl={runControl}
              />
            ) : null}
            {route.name === "traces" ? (
              <TracesPage
                requestTotal={reqTotal}
                requests={requests}
                trace={trace}
                traceId={route.traceId}
                error={traceError}
                selectedSpan={selectedSpan}
                onSelectSpan={setSelectedSpan}
                traceMsById={traceMsById}
                onJumpRequest={(id) => {
                  void fetchRequestTrace(id)
                    .then((payload) => {
                      window.location.hash = hrefFor("traces", payload.trace_id);
                    })
                    .catch((err: unknown) => setTraceError(err instanceof Error ? err.message : "request trace failed"));
                }}
              />
            ) : null}
            {route.name === "graph" ? (
              <GraphPage
                config={config?.services ?? []}
                services={services}
                requestPoints={requestPoints}
                logPoints={logPoints}
                latPoints={latPoints}
                hostPoints={hostPoints}
                busy={Boolean(busy)}
                onControl={runControl}
              />
            ) : null}
            {route.name === "logs" ? (
              <LogsPage logTotal={logTotal} serviceNames={services.map((row) => row.name)} initialService={route.logService} />
            ) : null}
            {route.name === "doctor" ? <DoctorPage /> : null}
            {route.name === "system" ? <SystemPage status={status} services={services} /> : null}
            {route.name === "identity" ? <IdentityPage status={status} /> : null}
            {route.name === "llm" ? (
              <LlmPage
                payload={llmCalls}
                detail={llmDetail}
                llmId={route.llmId}
                error={llmError || llmFeed.error}
                filters={llmFilters}
                onFilters={setLlmFilters}
                models={llmModels}
                feed={llmFeed}
                caller={llmCaller}
                callers={[...new Set([...services.map((row) => row.name), ...llmCallers])].sort()}
                search={llmSearch}
                onCaller={setLlmCaller}
                onSearch={setLlmSearch}
              />
            ) : null}
            {route.name === "traffic" ? (
              <TrafficPage
                payload={trafficCalls}
                detail={trafficDetail}
                trafficId={route.trafficId}
                error={trafficError || trafficFeed.error}
                filters={trafficFilters}
                onFilters={setTrafficFilters}
                routes={config?.proxy?.routes.map((row) => row.name) ?? []}
                feed={trafficFeed}
                caller={trafficCaller}
                callers={[...new Set([...services.map((row) => row.name), ...trafficCallers])].sort()}
                search={trafficSearch}
                onCaller={setTrafficCaller}
                onSearch={setTrafficSearch}
              />
            ) : null}
            {route.name === "settings" ? (
              <SettingsPage status={status} busy={Boolean(busy)} onBusy={externalBusy} onNotice={reportNotice} />
            ) : null}
            {route.name === "workspace" ? (
              <WorkspacePage
                profiles={profiles}
                tasks={config?.tasks ?? []}
                services={services}
                profile={status?.profile || ""}
                busy={Boolean(busy)}
                onControl={runControl}
                onBusy={externalBusy}
                onNotice={reportNotice}
              />
            ) : null}
            <div hidden={route.name !== "config"}>
              <ConfigPage config={config} active={route.name === "config"} busy={Boolean(busy)} onControl={runControl} />
            </div>
            {route.name === "proxy" ? <ProxyPage status={status} config={config} busy={Boolean(busy)} onControl={runControl} /> : null}
            {route.name === "services" && route.serviceId ? (
              <ServiceDetail
                key={route.serviceId}
                name={route.serviceId}
                row={services.find((row) => row.name === route.serviceId)}
                config={config?.services ?? []}
                busy={Boolean(busy)}
                onControl={runControl}
                onClose={() => {
                  window.location.hash = hrefFor("services");
                }}
              />
            ) : null}
          </PageBoundary>
        </ConsoleShell>
      </TooltipProvider>
    </IconContext.Provider>
  );
}
