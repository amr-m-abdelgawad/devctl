import type { ReactNode } from "react";
import { UPlotChart, type ChartStat, type SeriesPoint } from "../charts.tsx";
import { DependencyGraph } from "../graph.tsx";
import { hrefFor } from "../hash.ts";
import { useCascadeRestart } from "../hooks/use-cascade-restart.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ConfigService, ServiceRow } from "../types.ts";
import type { RunControl } from "../control.ts";

const CHART_HEIGHT = 168;
const RATE_WHOLE = 10;
const LATENCY_FAST_MS = 100;
const LATENCY_CEILING_STEP_MS = 50;
const LATENCY_SLOW_MS = 500;
const LATENCY_TAIL_RATIO = 3;
const CPU_BUSY = 80;
const CPU_QUIET = 15;
const MEM_HIGH = 85;
const MEM_OK = 70;

function lastValues(points: SeriesPoint[]): number[] {
  return points[points.length - 1]?.values ?? [];
}

export function GraphPage(props: {
  config: ConfigService[];
  services: ServiceRow[];
  requestPoints: SeriesPoint[];
  logPoints: SeriesPoint[];
  latPoints: SeriesPoint[];
  hostPoints: SeriesPoint[];
  busy?: boolean;
  onControl?: RunControl;
}) {
  const { config, services, requestPoints, logPoints, latPoints, hostPoints, busy = false, onControl } = props;
  const { requestRestart, banner } = useCascadeRestart(config, onControl ?? noopControl, busy);
  const request = lastValues(requestPoints);
  const log = lastValues(logPoints);
  const lat = lastValues(latPoints);
  const host = lastValues(hostPoints);
  const req = request[0] ?? 0;
  const reqFailed = request[1] ?? 0;
  const logs = log[0] ?? 0;
  const logFailed = log[1] ?? 0;
  const p50 = lat[0] ?? 0;
  const p95 = lat[1] ?? 0;
  const cpu = host[0] ?? 0;
  const mem = host[1] ?? 0;
  const ready = requestPoints.length >= 2;
  const logsReady = logPoints.length >= 2;
  const peakP95 = latPoints.reduce((max, point) => Math.max(max, point.values[1] ?? 0), 0);
  const latCeiling = Math.max(LATENCY_FAST_MS, Math.ceil(peakP95 / LATENCY_CEILING_STEP_MS) * LATENCY_CEILING_STEP_MS);

  const requestStats: ChartStat[] = [
    { label: "requests / s", value: req.toFixed(1), color: "#7ce0bd" },
    { label: "failed / s", value: reqFailed.toFixed(1), color: "#f4868d", tone: reqFailed > 0 ? "destructive" : "default" },
  ];
  const logStats: ChartStat[] = [
    { label: "logs / s", value: logs.toFixed(1), color: "#7ce0bd" },
    { label: "failed logs / s", value: logFailed.toFixed(1), color: "#f4868d", tone: logFailed > 0 ? "destructive" : "default" },
  ];
  const latStats: ChartStat[] = [
    { label: "median", value: `${Math.round(p50)}ms`, color: "#79c6dc" },
    { label: "slow tail", value: `${Math.round(p95)}ms`, color: "#ecc579", tone: p95 > LATENCY_SLOW_MS ? "warning" : "default" },
  ];
  const hostStats: ChartStat[] = [
    { label: "cpu", value: `${Math.round(cpu)}%`, color: "#7fe0a3", tone: cpu >= CPU_BUSY ? "warning" : "default" },
    { label: "memory", value: `${Math.round(mem)}%`, color: "#9fb8e8", tone: mem >= MEM_HIGH ? "warning" : "default" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Service topology</CardTitle>
          <Badge variant="muted">{config.length}</Badge>
        </CardHeader>
        <CardContent className="pt-0">
          {banner}
          <DependencyGraph config={config} services={services} busy={busy} onControl={onControl} onRestartServices={requestRestart} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 px-0.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Live signals</h2>
          <p className="text-[12px] text-muted-foreground">
            How the stack is behaving right now: proxy traffic, log volume, and load on this machine. Hover a plot for a timestamp.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <UPlotChart
            title="Requests"
            description="Green is proxy completions in the last 10s. Red is failed completions in that window: HTTP 4xx/5xx or a proxy error."
            labels={["requests/s", "failed/s"]}
            colors={["#7ce0bd", "#f4868d"]}
            points={requestPoints}
            height={CHART_HEIGHT}
            stats={requestStats}
            insight={requestInsight(req, reqFailed, ready)}
            empty="Rates appear after the second poll (~2s)."
          />
          <UPlotChart
            title="Logs"
            description="Green is log lines ingested in the last 10s. Red is ERROR and FATAL lines in the same window."
            labels={["logs/s", "failed logs/s"]}
            colors={["#7ce0bd", "#f4868d"]}
            points={logPoints}
            height={CHART_HEIGHT}
            stats={logStats}
            insight={logInsight(logs, logFailed, logsReady)}
            empty="Rates appear after the second poll (~2s)."
          />
          <UPlotChart
            title="Proxy latency"
            description="How long upstreams took to answer, measured at the proxy. Median vs the slow tail of the recent request buffer."
            labels={["median", "slow tail"]}
            colors={["#79c6dc", "#ecc579"]}
            points={latPoints}
            yMax={latCeiling}
            yUnit="ms"
            height={CHART_HEIGHT}
            stats={latStats}
            insight={latencyInsight(p50, p95, ready)}
            empty="Latency appears once the proxy has timings."
          />
          <UPlotChart
            title="This machine"
            description="CPU and memory of the host running these processes — not a single service. Use it to tell stack slowness from a laptop under load."
            labels={["cpu", "memory"]}
            colors={["#7fe0a3", "#9fb8e8"]}
            points={hostPoints}
            yMax={100}
            yUnit="%"
            height={CHART_HEIGHT}
            stats={hostStats}
            insight={hostInsight(cpu, mem, hostPoints.length >= 2)}
            empty="Waiting for the host sampler…"
          />
        </div>
      </div>
    </div>
  );
}

function formatPerSec(value: number): string {
  return value.toFixed(value >= RATE_WHOLE ? 0 : 1);
}

function requestInsight(req: number, failed: number, ready: boolean): ReactNode {
  if (!ready) {
    return "Rates appear after the second poll (~2s).";
  }
  if (req === 0 && failed === 0) {
    return "No proxy completions in the last 10 seconds.";
  }
  if (failed <= 0) {
    return "Traffic is flowing through the proxy with no failed requests this window.";
  }
  return (
    <>
      {formatPerSec(failed)} failed requests per second (HTTP 4xx/5xx or a proxy error).{" "}
      <a href={hrefFor("traces")} className="text-primary underline-offset-4 hover:underline">Open Traces</a>
    </>
  );
}

function logInsight(logs: number, failed: number, ready: boolean): ReactNode {
  if (!ready) {
    return "Rates appear after the second poll (~2s).";
  }
  if (logs === 0 && failed === 0) {
    return "No log lines in the last 10 seconds.";
  }
  if (failed <= 0) {
    return "Logs are arriving with no ERROR or FATAL lines this window.";
  }
  return (
    <>
      {formatPerSec(failed)} ERROR or FATAL logs per second.{" "}
      <a href={hrefFor("logs")} className="text-primary underline-offset-4 hover:underline">Open Logs</a>
    </>
  );
}

function latencyInsight(p50: number, p95: number, ready: boolean): ReactNode {
  if (!ready || (p50 === 0 && p95 === 0)) {
    return "No recent proxy timings yet.";
  }
  if (p95 > LATENCY_SLOW_MS) {
    return (
      <>
        Slow tail is over {LATENCY_SLOW_MS}ms — an upstream is stalling.{" "}
        <a href={hrefFor("traces")} className="text-primary underline-offset-4 hover:underline">Open Traces</a>
      </>
    );
  }
  if (p50 > 0 && p95 > p50 * LATENCY_TAIL_RATIO) {
    return `Slow tail is ${Math.round(p95 / p50)}× the median — a few requests are much worse than the rest.`;
  }
  if (p95 <= LATENCY_FAST_MS) {
    return `Upstreams are answering quickly (most around ${Math.round(p50)}ms).`;
  }
  return `Most requests finish around ${Math.round(p50)}ms; the slow ones around ${Math.round(p95)}ms.`;
}

function hostInsight(cpu: number, mem: number, ready: boolean): string {
  if (!ready) {
    return "Waiting for the host sampler…";
  }
  if (mem >= MEM_HIGH) {
    return "Memory is high on this machine — local services may start feeling it.";
  }
  if (cpu >= CPU_BUSY) {
    return "CPU is busy on this machine — the stack may feel sluggish even if services are healthy.";
  }
  if (cpu < CPU_QUIET && mem < MEM_OK) {
    return "This machine has headroom. If something is slow, look at the service, not the laptop.";
  }
  return "Host load for the machine running the stack, not a per-service metric.";
}

function noopControl(): void {
  return;
}
