import { useEffect, useRef, useState, type ReactNode } from "react";
import uPlot from "uplot";
import { cn } from "./lib/utils.ts";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.tsx";

const DEFAULT_HEIGHT = 168;
const MIN_PLOT_WIDTH = 240;
const AXIS_SIZE = 44;
const CURSOR_POINT = 5;

export type ChartStat = {
  label: string;
  value: string;
  color: string;
  tone?: "default" | "destructive" | "warning";
};

const AXIS: uPlot.Axis = {
  stroke: "#93a89e",
  font: "10px ui-monospace, monospace",
  grid: { stroke: "rgba(41,56,47,0.7)", width: 1 },
  ticks: { stroke: "rgba(41,56,47,0.7)", width: 1 },
};

const STAT_TONE: Record<NonNullable<ChartStat["tone"]>, string> = {
  default: "text-foreground",
  destructive: "text-destructive",
  warning: "text-warning",
};

export type SeriesPoint = { t: number; values: number[] };

function toData(labels: string[], points: SeriesPoint[]): uPlot.AlignedData {
  return [
    points.map((point) => point.t),
    ...labels.map((_, index) => points.map((point) => point.values[index] ?? 0)),
  ];
}

function fillFor(stroke: string): string {
  const hex = stroke.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.10)`;
}

function formatY(value: number, unit: string): string {
  if (unit === "%" || unit === "ms") {
    return `${Math.round(value)}`;
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

function formatHover(t: number, labels: string[], values: number[], unit: string): string {
  const clock = new Date(t * 1000).toISOString().slice(11, 19);
  const parts = labels.map((label, index) => `${formatY(values[index] ?? 0, unit)}${unit} ${label}`);
  return `${clock}  ·  ${parts.join("  ·  ")}`;
}

export function UPlotChart(props: {
  title: string;
  description?: string;
  insight?: ReactNode;
  labels: string[];
  colors: string[];
  points: SeriesPoint[];
  yMax?: number;
  yUnit?: string;
  height?: number;
  stats?: ChartStat[];
  empty?: string;
}) {
  const { title, description, insight, labels, colors, points, yMax, yUnit = "", height: heightProp, stats, empty } = props;
  const height = heightProp ?? DEFAULT_HEIGHT;
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | undefined>(undefined);
  const latest = useRef({ labels, colors, points, yMax, height, yUnit });
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    latest.current = { labels, colors, points, yMax, height, yUnit };
  }, [labels, colors, points, yMax, height, yUnit]);

  const structureKey = `${labels.join("|")}::${colors.join("|")}::${yMax ?? ""}::${height}::${yUnit}`;
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { labels: lbl, colors: col, points: pts, yMax: ymax, height: h, yUnit: unit } = latest.current;
    const opts: uPlot.Options = {
      width: Math.max(MIN_PLOT_WIDTH, el.clientWidth || MIN_PLOT_WIDTH),
      height: h,
      cursor: { show: true, points: { size: CURSOR_POINT } },
      legend: { show: false },
      scales: { x: { time: true }, y: ymax !== undefined ? { range: [0, ymax] } : {} },
      axes: [
        { ...AXIS, values: (_u, splits) => splits.map((s) => new Date(s * 1000).toISOString().slice(11, 19)) },
        { ...AXIS, size: AXIS_SIZE, values: (_u, splits) => splits.map((s) => formatY(s, unit)) },
      ],
      series: [
        {},
        ...lbl.map((label, index) => {
          const stroke = col[index] ?? "#7ce0bd";
          return { label, stroke, fill: fillFor(stroke), width: 2, points: { show: false } };
        }),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            if (idx == null || idx < 0) {
              setHover(null);
              return;
            }
            const t = u.data[0]?.[idx];
            if (typeof t !== "number") {
              setHover(null);
              return;
            }
            const values = lbl.map((_, index) => Number(u.data[index + 1]?.[idx] ?? 0));
            setHover(formatHover(t, lbl, values, unit));
          },
        ],
      },
    };
    const chart = new uPlot(opts, toData(lbl, pts), el);
    plot.current = chart;
    const ro = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(MIN_PLOT_WIDTH, el.clientWidth || MIN_PLOT_WIDTH), height: h });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.destroy();
      plot.current = undefined;
    };
  }, [structureKey]);

  useEffect(() => {
    plot.current?.setData(toData(labels, points));
  }, [labels, points]);

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-col items-stretch gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <p className="text-[12px] leading-snug text-muted-foreground">{description}</p> : null}
        </div>
        {stats && stats.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {stats.map((stat) => (
              <span key={stat.label} className="flex items-baseline gap-1.5">
                <span className="size-2 shrink-0 translate-y-px rounded-sm" style={{ backgroundColor: stat.color }} />
                <span className={cn("font-mono text-sm font-semibold tabular-nums", STAT_TONE[stat.tone ?? "default"])}>{stat.value}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</span>
              </span>
            ))}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col pt-0">
        <div className="relative" style={{ height }}>
          <div className="absolute inset-0 overflow-hidden" ref={ref} />
          {points.length < 2 ? (
            <div className="absolute inset-0 flex items-center px-1 text-sm text-muted-foreground">
              {empty ?? "Waiting for the next poll…"}
            </div>
          ) : null}
        </div>
        <p className={cn("mt-2 min-h-[2.5rem] text-[12px] leading-snug", hover ? "font-mono text-foreground/90" : "text-muted-foreground")}>
          {hover ?? insight}
        </p>
      </CardContent>
    </Card>
  );
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}
