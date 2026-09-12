import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchConfig, fetchLogs, fetchProfiles, fetchRequestTrace, fetchRequests, fetchServices, fetchStatus, fetchTrace } from "./api.ts";
import { percentile, UPlotChart, type SeriesPoint } from "./charts.tsx";
import { DependencyGraph } from "./graph.tsx";
import { hrefFor, parseHash } from "./hash.ts";
import type {
  ConfigSummary,
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
import { Waterfall } from "./waterfall.tsx";

const POLL_MS = 2000;
const WINDOW = 60;
const NAV: Array<{ name: RouteName; label: string }> = [
  { name: "services", label: "Services" },
  { name: "traces", label: "Traces" },
  { name: "graph", label: "Graph" },
  { name: "logs", label: "Logs" },
];

type RateSample = { t: number; reqs: number; errs: number; p50: number; p95: number };

function readRoute(): Route {
  return parseHash(window.location.hash);
}

function Chip(props: { label: string; value: string; tone?: "ok" | "bad" | "warn" }) {
  return (
    <span className={`chip ${props.tone ?? ""}`}>
      {props.label}
      <b>{props.value}</b>
    </span>
  );
}

function Pill(props: { value: string }) {
  return <span className={`pill ${props.value.toLowerCase()}`}>{props.value}</span>;
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
  const lastTotals = useRef<{ t: number; reqs: number; errs: number } | undefined>(undefined);

  const poll = useCallback(async () => {
    const [nextStatus, nextServices, nextRequests, nextConfig, nextErrors, nextProfiles] = await Promise.all([
      fetchStatus(),
      fetchServices(),
      fetchRequests(),
      fetchConfig(),
      fetchLogs({ level: "ERROR" }),
      fetchProfiles(),
    ]);
    setStatus(nextStatus);
    setServices(nextServices);
    setRequests(nextRequests);
    setConfig(nextConfig);
    setErrors(nextErrors.events);
    setProfiles(nextProfiles);
    setPollError("");
    const now = Date.now() / 1000;
    const reqs = nextStatus.proxy.requestTotal ?? 0;
    const errs = nextStatus.proxy.requestErrors ?? 0;
    const prev = lastTotals.current;
    const lat = (nextRequests.requests ?? []).map((row) => row.duration_ms);
    const dt = prev ? Math.max(now - prev.t, 0.001) : 0;
    const sample: RateSample = {
      t: now,
      reqs: prev ? Math.max(0, (reqs - prev.reqs) / dt) : 0,
      errs: prev ? Math.max(0, (errs - prev.errs) / dt) : 0,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
    };
    lastTotals.current = { t: now, reqs, errs };
    setRates((cur) => [...cur, sample].slice(-WINDOW));
  }, []);

  useEffect(() => {
    void poll().catch((err: unknown) => {
      setPollError(err instanceof Error ? err.message : "poll failed");
    });
    const timer = window.setInterval(() => void poll().catch((err: unknown) => {
      setPollError(err instanceof Error ? err.message : "poll failed");
    }), POLL_MS);
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
  }, [route.name, logFilter, requests?.total, status?.logs.total]);

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

  return (
    <div className="app">
      <header className="mast">
        <div className="brand">
          <strong>devctl</strong>
          <span>telemetry explorer</span>
        </div>
        <div className="chips">
          <Chip label="profile" value={status?.profile || profiles[0]?.name || "(none)"} />
          <Chip label="proxy" value={status?.proxy.running ? "up" : "down"} tone={status?.proxy.running ? "ok" : "warn"} />
          <Chip label="mcp" value={status?.mcp.running ? "up" : "down"} />
          <Chip label="web" value={status?.web.running ? "up" : "down"} tone={status?.web.running ? "ok" : "warn"} />
          <Chip label="reqs" value={String(status?.proxy.requestTotal ?? 0)} />
          <Chip label="errors" value={String(status?.proxy.requestErrors ?? status?.logs.errors ?? 0)} tone={(status?.proxy.requestErrors ?? 0) > 0 ? "bad" : undefined} />
        </div>
        {pollError ? <span className="error-text">{pollError}</span> : <span className="muted">poll {POLL_MS / 1000}s</span>}
      </header>
      <nav className="nav">
        {NAV.map((item) => (
          <a key={item.name} href={hrefFor(item.name)} className={route.name === item.name ? "active" : ""}>{item.label}</a>
        ))}
      </nav>
      <main className="page">
        {route.name === "services" ? (
          <ServicesPage services={services} requests={requests} errors={errors} profiles={profiles} />
        ) : null}
        {route.name === "traces" ? (
          <TracesPage
            requests={requests}
            trace={trace}
            traceId={route.traceId}
            error={traceError}
            selectedSpan={selectedSpan}
            onSelectSpan={setSelectedSpan}
            onJumpRequest={(id) => {
              void fetchRequestTrace(id).then((payload) => {
                window.location.hash = hrefFor("traces", payload.trace_id);
              }).catch((err: unknown) => setTraceError(err instanceof Error ? err.message : "request trace failed"));
            }}
          />
        ) : null}
        {route.name === "graph" ? (
          <div>
            <div className="card">
              <h2>Dependencies</h2>
              <DependencyGraph config={config?.services ?? []} services={services} />
            </div>
            <div className="grid-charts">
              <UPlotChart title="Request / error rate" labels={["req/s", "err/s"]} colors={["#77ddba", "#f28b91"]} points={ratePoints} />
              <UPlotChart title="Latency (ms)" labels={["p50", "p95"]} colors={["#8ec8d8", "#e8c586"]} points={latPoints} />
              <UPlotChart title="Host CPU / mem %" labels={["cpu", "mem"]} colors={["#9ee9cf", "#deeee5"]} points={hostPoints} yMax={100} />
            </div>
          </div>
        ) : null}
        {route.name === "logs" ? (
          <LogsPage
            logs={logs}
            serviceChips={serviceChips}
            levelChips={levelChips}
            filter={logFilter}
            onFilter={setLogFilter}
          />
        ) : null}
      </main>
    </div>
  );
}

function ServicesPage(props: { services: ServiceRow[]; requests?: RequestsPayload; errors: LogRow[]; profiles: ProfileRow[] }) {
  const { services, requests, errors, profiles } = props;
  return (
    <div className="grid-2">
      <section className="card">
        <h2>Services</h2>
        {services.length === 0 ? <div className="empty">No services.</div> : (
          <table>
            <thead><tr><th>Name</th><th>State</th><th>Health</th><th>PID</th><th>Ports</th></tr></thead>
            <tbody>
              {services.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td><Pill value={row.state} /></td>
                  <td><Pill value={row.health || "unknown"} /></td>
                  <td className="num">{row.pid || "—"}</td>
                  <td className="mono muted">{Object.entries(row.ports ?? {}).map(([name, port]) => `${name}:${port}`).join(" ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Profiles</h2>
        {profiles.length === 0 ? <div className="empty">No profiles.</div> : (
          <table>
            <thead><tr><th>Name</th><th>Services</th></tr></thead>
            <tbody>
              {profiles.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td className="muted">{row.services.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Recent errors</h2>
        {errors.length === 0 ? <div className="empty">No error-level logs.</div> : (
          <table>
            <thead><tr><th>Time</th><th>Service</th><th>Message</th></tr></thead>
            <tbody>
              {errors.slice(-12).reverse().map((row, index) => (
                <tr key={`${row.seq ?? index}`}>
                  <td className="mono muted">{row.timestamp.slice(11, 19) || row.timestamp}</td>
                  <td>{row.service}</td>
                  <td>{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" style={{ gridColumn: "1 / -1" }}>
        <h2>Proxy requests</h2>
        <RequestTable requests={requests?.requests ?? []} />
      </section>
    </div>
  );
}

function RequestTable(props: { requests: Array<{ timestamp: string; request_id: string; trace_id?: string; method: string; path: string; status: number; duration_ms: number; error?: string }>; onJumpRequest?: (id: string) => void }) {
  const { requests, onJumpRequest } = props;
  if (requests.length === 0) {
    return <div className="empty">No proxied requests yet.</div>;
  }
  return (
    <table>
      <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th><th>Trace</th></tr></thead>
      <tbody>
        {requests.slice().reverse().map((row) => (
          <tr key={row.request_id}>
            <td className="mono muted">{row.timestamp.slice(11, 23) || row.timestamp}</td>
            <td>{row.method}</td>
            <td className="mono">{row.path}</td>
            <td className={row.status >= 500 ? "error-text" : ""}>{row.status}</td>
            <td className="num">{row.duration_ms}</td>
            <td>
              {row.trace_id ? <a href={hrefFor("traces", row.trace_id)}>{row.trace_id.slice(0, 12)}</a> : onJumpRequest ? (
                <button className="filter" onClick={() => onJumpRequest(row.request_id)}>open</button>
              ) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TracesPage(props: {
  requests?: RequestsPayload;
  trace?: TracePayload;
  traceId?: string;
  error: string;
  selectedSpan: string;
  onSelectSpan: (id: string) => void;
  onJumpRequest: (id: string) => void;
}) {
  const { requests, trace, traceId, error, selectedSpan, onSelectSpan, onJumpRequest } = props;
  const spanLogs = selectedSpan ? (trace?.logs ?? []).filter((row) => row.spanId === selectedSpan) : (trace?.logs ?? []);
  return (
    <div className="split">
      <section className="card">
        <h2>{traceId ? `Trace ${traceId}` : "Recent traces"}</h2>
        {traceId ? <div className="muted" style={{ marginBottom: 8 }}><a href={hrefFor("traces")}>all requests</a></div> : null}
        {error ? <div className="error-text">{error}</div> : null}
        {traceId && trace ? (
          <Waterfall spans={trace.spans} selected={selectedSpan} onSelect={onSelectSpan} />
        ) : (
          <RequestTable requests={requests?.requests ?? []} onJumpRequest={onJumpRequest} />
        )}
      </section>
      <section className="card">
        <h2>Correlated logs</h2>
        {!traceId ? <div className="empty">Select a request with a trace id.</div> : (
          <LogTable events={spanLogs} />
        )}
      </section>
    </div>
  );
}

function LogsPage(props: {
  logs?: LogsPayload;
  serviceChips: string[];
  levelChips: string[];
  filter: { service: string; level: string };
  onFilter: (next: { service: string; level: string }) => void;
}) {
  const { logs, serviceChips, levelChips, filter, onFilter } = props;
  const events = (logs?.events ?? []).filter((row) => {
    if (filter.service && row.service !== filter.service) {
      return false;
    }
    if (filter.level && (row.level || row.severityText) !== filter.level) {
      return false;
    }
    return true;
  });
  return (
    <section className="card">
      <h2>Logs</h2>
      <div className="filters">
        <button className={`filter ${filter.service === "" ? "on" : ""}`} onClick={() => onFilter({ ...filter, service: "" })}>all services</button>
        {serviceChips.map((name) => (
          <button key={name} className={`filter ${filter.service === name ? "on" : ""}`} onClick={() => onFilter({ ...filter, service: name })}>{name}</button>
        ))}
      </div>
      <div className="filters">
        <button className={`filter ${filter.level === "" ? "on" : ""}`} onClick={() => onFilter({ ...filter, level: "" })}>all levels</button>
        {levelChips.map((name) => (
          <button key={name} className={`filter ${filter.level === name ? "on" : ""}`} onClick={() => onFilter({ ...filter, level: name })}>{name}</button>
        ))}
      </div>
      <LogTable events={events} />
    </section>
  );
}

function LogTable(props: { events: LogRow[] }) {
  const { events } = props;
  if (events.length === 0) {
    return <div className="empty">No log records.</div>;
  }
  return (
    <table>
      <thead><tr><th>Time</th><th>Svc</th><th>Lvl</th><th>Message</th><th>Trace</th></tr></thead>
      <tbody>
        {events.slice().reverse().map((row, index) => (
          <tr key={`${row.seq ?? index}-${row.timestamp}`}>
            <td className="mono muted">{row.timestamp.slice(11, 23) || row.timestamp}</td>
            <td>{row.service}</td>
            <td><Pill value={row.level || row.severityText} /></td>
            <td>{row.message}</td>
            <td>{row.traceId ? <a href={hrefFor("traces", row.traceId)}>{row.traceId.slice(0, 12)}</a> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
