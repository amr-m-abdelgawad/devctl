import { LayoutDashboard, Network, Play, RefreshCw, ScrollText, Square, Waypoints } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchConfig, fetchLogs, fetchProfiles, fetchRequestTrace, fetchRequests, fetchServices, fetchStatus, fetchTrace, postControl } from "./api.ts";
import { percentile, type SeriesPoint } from "./charts.tsx";
import { ControlNotice } from "./components/controls.tsx";
import { noticeFor, type RunControl } from "./control.ts";
import { NANOS_PER_MS, traceEnvelopeNs } from "./format.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { DevctlLogo } from "./brand.tsx";
import { hrefFor, parseHash } from "./hash.ts";
import { advanceRingCounter, emptyRingCounter, lifetimeTotal, logLifetime } from "./lifetime.ts";
import { OverviewPage, type OverviewSummary } from "./pages/overview.tsx";
import { GraphPage } from "./pages/graph.tsx";
import { LogsPage } from "./pages/logs.tsx";
import { TracesPage } from "./pages/traces.tsx";
import type {
  ConfigSummary,
  ControlArgs,
  ControlTool,
  LogRow,
  LogsPayload,
  ProfileRow,
  RequestsPayload,
  Route,
  RouteName,
  ServiceRow,
  StatusSummary,
  TracePayload,
} from "./types.ts";

const POLL_MS = 2000;
const WINDOW = 60;
const RATE_LOOKBACK_MS = 10_000;
const NAV: Array<{ name: RouteName; label: string; icon: typeof LayoutDashboard }> = [
  { name: "services", label: "Overview", icon: LayoutDashboard },
  { name: "traces", label: "Traces", icon: Waypoints },
  { name: "graph", label: "Graph", icon: Network },
  { name: "logs", label: "Logs", icon: ScrollText },
];

type RateSample = { t: number; reqs: number; errs: number; p50: number; p95: number };

function rateInWindow(timestamps: string[], nowMs: number, lookbackMs: number): number {
  const cutoff = nowMs - lookbackMs;
  const seconds = lookbackMs / 1000;
  let count = 0;
  for (const stamp of timestamps) {
    const ts = Date.parse(stamp);
    if (!Number.isNaN(ts) && ts >= cutoff) {
      count += 1;
    }
  }
  return count / seconds;
}

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
  const [logs, setLogs] = useState<LogsPayload | undefined>(undefined);
  const [trace, setTrace] = useState<TracePayload | undefined>(undefined);
  const [traceError, setTraceError] = useState("");
  const [selectedSpan, setSelectedSpan] = useState("");
  const [logFilter, setLogFilter] = useState<{ service: string; level: string }>({ service: "", level: "" });
  const [pollError, setPollError] = useState("");
  const [rates, setRates] = useState<RateSample[]>([]);
  const [traceMsById, setTraceMsById] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  const traceMsRef = useRef<Record<string, number>>({});
  const requestLifeRef = useRef(emptyRingCounter());
  useEffect(() => {
    traceMsRef.current = traceMsById;
  }, [traceMsById]);

  const poll = useCallback(async () => {
    const [nextStatus, nextServices, nextRequests, nextConfig, nextErrors, nextProfiles] = await Promise.all([
      fetchStatus(),
      fetchServices(),
      fetchRequests(),
      fetchConfig(),
      fetchLogs({ level: "ERROR" }),
      fetchProfiles(),
    ]);
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
    const lat = (nextRequests.requests ?? []).map((row) => row.duration_ms);
    const reqs = rateInWindow((nextRequests.requests ?? []).map((row) => row.timestamp), nowMs, RATE_LOOKBACK_MS);
    const errs = rateInWindow(nextErrors.events.map((row) => row.timestamp), nowMs, RATE_LOOKBACK_MS);
    const sample: RateSample = {
      t: nowMs / 1000,
      reqs,
      errs,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
    };
    setRates((cur) => [...cur, sample].slice(-WINDOW));
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

  const runControl: RunControl = useCallback((tool: ControlTool, args: ControlArgs = {}, label?: string) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(label || tool);
    setNotice("");
    void (async () => {
      try {
        const result = await postControl(tool, args);
        setNotice(noticeFor(tool, result, args));
        await poll();
      } catch (err: unknown) {
        setNotice(err instanceof Error ? err.message : "control failed");
      } finally {
        busyRef.current = false;
        setBusy("");
      }
    })();
  }, [poll]);

  useEffect(() => {
    const run = (): void => {
      void poll().catch((err: unknown) => setPollError(err instanceof Error ? err.message : "poll failed"));
    };
    run();
    const timer = window.setInterval(run, POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  useEffect(() => {
    if (route.name !== "logs") {
      return;
    }
    const params: Record<string, string> = {};
    if (logFilter.service) {
      params.service = logFilter.service;
    }
    if (logFilter.level) {
      params.level = logFilter.level;
    }
    void fetchLogs(params).then(setLogs).catch((err: unknown) => {
      setPollError(err instanceof Error ? err.message : "logs failed");
    });
  }, [route.name, logFilter, requests?.total, status?.logs.total, status?.logs.seen]);

  useEffect(() => {
    if (route.name !== "traces" || !route.traceId) {
      setTrace(undefined);
      setTraceError("");
      return;
    }
    setSelectedSpan("");
    void fetchTrace(route.traceId).then((payload) => {
      setTrace(payload);
      setTraceError("");
    }).catch((err: unknown) => {
      setTrace(undefined);
      setTraceError(err instanceof Error ? err.message : "trace failed");
    });
  }, [route.name, route.traceId]);

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

  const serviceChips = useMemo(() => {
    const names = new Set<string>();
    for (const row of logs?.events ?? errors) {
      names.add(row.service);
    }
    return [...names].sort();
  }, [logs, errors]);
  const levelChips = useMemo(() => {
    const names = new Set<string>();
    for (const row of logs?.events ?? errors) {
      names.add(row.level || row.severityText);
    }
    return [...names].sort();
  }, [logs, errors]);

  const ratePoints: SeriesPoint[] = rates.map((row) => ({ t: row.t, values: [row.reqs, row.errs] }));
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
  const logTotal = logCounts.total;
  const logErrors = logCounts.errors;
  const last = rates[rates.length - 1];
  const summary: OverviewSummary = {
    total: services.length,
    healthy: services.filter((s) => {
      const h = (s.health || "").toUpperCase();
      const st = (s.state || "").toUpperCase();
      return h === "HEALTHY" || st === "RUNNING" || st === "HEALTHY";
    }).length,
    requests: reqTotal,
    errors: logErrors,
    errorRate: logTotal > 0 ? (logErrors / logTotal) * 100 : 0,
    errPerSec: last?.errs ?? 0,
    p95: last?.p95 ?? 0,
    reqPerSec: last?.reqs ?? 0,
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-2.5">
            <div className="flex items-center gap-2">
              <DevctlLogo className="size-7 shrink-0" />
              <div className="flex items-baseline gap-2">
                <span className="text-[15px] font-semibold tracking-tight text-primary">devctl</span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">console</span>
              </div>
            </div>

            <nav className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1">
              {NAV.map((item) => {
                const active = route.name === item.name;
                return (
                  <a
                    key={item.name}
                    href={hrefFor(item.name)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                      active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </a>
                );
              })}
            </nav>

            <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
              <ControlNotice busy={busy} notice={notice} />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  disabled={Boolean(busy)}
                  title={status?.proxy.running ? "Stop proxy" : "Start proxy"}
                  onClick={() => runControl(status?.proxy.running ? "stop_proxy" : "start_proxy", {}, status?.proxy.running ? "Stopping proxy…" : "Starting proxy…")}
                >
                  {status?.proxy.running ? <Square className="size-3" /> : <Play className="size-3" />}
                  <ConnDot label="proxy" up={status?.proxy.running} />
                </button>
                <ConnDot label="mcp" up={status?.mcp.running} />
                <ConnDot label="web" up={status?.web.running} />
              </div>
              <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {status?.profile || profiles[0]?.name || "(none)"}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => runControl("reload_config", {}, "Reloading config…")}
              >
                <RefreshCw />
                Reload
              </Button>
              {pollError ? (
                <span className="max-w-[220px] truncate text-xs text-destructive" title={pollError}>{pollError}</span>
              ) : (
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="size-1.5 animate-pulse rounded-full bg-success" />
                  live · {POLL_MS / 1000}s
                </span>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 p-5" aria-busy={Boolean(busy)}>
          {route.name === "services" ? (
            <OverviewPage
              summary={summary}
              services={services}
              requests={requests}
              errors={errors}
              profiles={profiles}
              tasks={config?.tasks ?? []}
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
                void fetchRequestTrace(id).then((payload) => {
                  window.location.hash = hrefFor("traces", payload.trace_id);
                }).catch((err: unknown) => setTraceError(err instanceof Error ? err.message : "request trace failed"));
              }}
            />
          ) : null}
          {route.name === "graph" ? (
            <GraphPage
              config={config?.services ?? []}
              services={services}
              ratePoints={ratePoints}
              latPoints={latPoints}
              hostPoints={hostPoints}
              busy={Boolean(busy)}
              onControl={runControl}
            />
          ) : null}
          {route.name === "logs" ? (
            <LogsPage
              logs={logs}
              logTotal={logTotal}
              serviceChips={serviceChips}
              levelChips={levelChips}
              filter={logFilter}
              onFilter={setLogFilter}
            />
          ) : null}
        </main>
      </div>
    </TooltipProvider>
  );
}

function ConnDot(props: { label: string; up?: boolean }) {
  return (
    <span className="flex items-center gap-1.5" title={`${props.label} ${props.up ? "up" : "down"}`}>
      <span className={cn("size-1.5 rounded-full", props.up ? "bg-success" : "bg-muted-foreground/40")} />
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
    </span>
  );
}
