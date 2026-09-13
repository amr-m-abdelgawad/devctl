import type { ReactNode } from "react";
import { UPlotChart, type ChartStat, type SeriesPoint } from "../charts.tsx";
import { DependencyGraph } from "../graph.tsx";
import { hrefFor } from "../hash.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ConfigService, ServiceRow } from "../types.ts";
import type { RunControl } from "../control.ts";

const CHART_HEIGHT = 168;
const LATENCY_FAST_MS = 100;
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
  ratePoints: SeriesPoint[];
  latPoints: SeriesPoint[];
  hostPoints: SeriesPoint[];
  busy?: boolean;
  onControl?: RunControl;
}) {
  const { config, services, ratePoints, latPoints, hostPoints, busy, onControl } = props;
  const rate = lastValues(ratePoints);
  const lat = lastValues(latPoints);
  const host = lastValues(hostPoints);
  const req = rate[0] ?? 0;
  const err = rate[1] ?? 0;
  const p50 = lat[0] ?? 0;
  const p95 = lat[1] ?? 0;
  const cpu = host[0] ?? 0;
  const mem = host[1] ?? 0;
  const ready = ratePoints.length >= 2;
  const latCeiling = Math.max(LATENCY_FAST_MS, Math.ceil((p95 || 0) / 50) * 50);

  const rateStats: ChartStat[] = [
    { label: "requests / s", value: req.toFixed(1), color: "#7ce0bd" },
    { label: "log errors / s", value: err.toFixed(1), color: "#f4868d", tone: err > 0 ? "destructive" : "default" },
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
        <CardContent className="pt-0"><DependencyGraph config={config} services={services} busy={busy} onControl={onControl} /></CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 px-0.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Live signals</h2>
          <p className="text-[12px] text-muted-foreground">
            How the stack is behaving right now: proxy traffic, ERROR logs, and load on this machine. Hover a plot for a timestamp.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <UPlotChart
            title="Traffic and errors"
            description="Green is proxy completions in the last 10s. Red is ERROR/FATAL log lines in the same window — the records on the Logs page, not only failed HTTP responses."
            labels={["requests/s", "log errors/s"]}
            colors={["#7ce0bd", "#f4868d"]}
            points={ratePoints}
            height={CHART_HEIGHT}
            stats={rateStats}
            insight={trafficInsight(req, err, ready)}
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

function trafficInsight(req: number, err: number, ready: boolean): ReactNode {
  if (!ready) {
    return "Rates appear after the second poll (~2s).";
  }
  if (req === 0 && err === 0) {
    return "No proxy completions or ERROR logs in the last 10 seconds.";
  }
  if (err <= 0) {
    return "Traffic is flowing through the proxy with no ERROR/FATAL logs this window.";
  }
  return (
    <>
      {err.toFixed(err >= 10 ? 0 : 1)} ERROR logs per second — the same stream as Logs
      {req > 0 ? ", including application failures that still returned HTTP 200" : ""}.{" "}
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
