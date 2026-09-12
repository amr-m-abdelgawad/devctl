import { useEffect, useRef } from "react";
import uPlot from "uplot";

const AXIS = {
  stroke: "#a4b9ae",
  grid: { stroke: "#526d60", width: 1 },
  ticks: { stroke: "#526d60" },
};

export type SeriesPoint = { t: number; values: number[] };

export function UPlotChart(props: { title: string; labels: string[]; colors: string[]; points: SeriesPoint[]; yMax?: number }) {
  const { title, labels, colors, points, yMax } = props;
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const data: uPlot.AlignedData = [
      points.map((point) => point.t),
      ...labels.map((_, index) => points.map((point) => point.values[index] ?? 0)),
    ];
    const opts: uPlot.Options = {
      width: Math.max(280, el.clientWidth || 320),
      height: 160,
      cursor: { show: true },
      legend: { show: true },
      scales: { x: { time: true }, y: yMax !== undefined ? { range: [0, yMax] } : {} },
      axes: [
        { ...AXIS, values: (_u, splits) => splits.map((s) => new Date(s * 1000).toISOString().slice(11, 19)) },
        { ...AXIS },
      ],
      series: [
        {},
        ...labels.map((label, index) => ({
          label,
          stroke: colors[index] ?? "#77ddba",
          width: 1.6,
        })),
      ],
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el);
    return () => {
      plot.current?.destroy();
      plot.current = undefined;
    };
  }, [colors, labels, points, yMax]);

  return (
    <div className="card">
      <h2>{title}</h2>
      {points.length < 2 ? <div className="empty">Collecting samples…</div> : <div className="chart" ref={ref} />}
    </div>
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
