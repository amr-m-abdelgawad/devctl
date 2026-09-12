import type { SpanRow } from "./types.ts";

const LANE_H = 28;
const LABEL_W = 168;
const PAD = 12;
const BAR_H = 14;

const STATUS_FILL: Record<string, string> = {
  error: "#f28b91",
  ok: "#91d6a0",
  unset: "#77ddba",
};

function serviceName(span: SpanRow): string {
  const name = span.resource["service.name"];
  return typeof name === "string" && name !== "" ? name : "unknown";
}

function childrenOf(spans: SpanRow[]): Map<string, SpanRow[]> {
  const byId = new Set(spans.map((span) => span.spanId));
  const kids = new Map<string, SpanRow[]>();
  for (const span of spans) {
    const parent = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : "";
    const list = kids.get(parent) ?? [];
    list.push(span);
    kids.set(parent, list);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => a.startUnixNano - b.startUnixNano);
  }
  return kids;
}

function walk(spans: SpanRow[]): SpanRow[] {
  const kids = childrenOf(spans);
  const out: SpanRow[] = [];
  const visit = (span: SpanRow): void => {
    out.push(span);
    for (const child of kids.get(span.spanId) ?? []) {
      visit(child);
    }
  };
  for (const root of kids.get("") ?? []) {
    visit(root);
  }
  return out;
}

function formatNs(ns: number): string {
  const ms = ns / 1_000_000;
  if (ms < 1) {
    return `${(ns / 1000).toFixed(0)}µs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

export function Waterfall(props: { spans: SpanRow[]; selected?: string; onSelect: (spanId: string) => void }) {
  const { spans, selected, onSelect } = props;
  if (spans.length === 0) {
    return <div className="empty">No spans in this trace.</div>;
  }
  const ordered = walk(spans);
  const lanes = [...new Set(ordered.map(serviceName))];
  const t0 = Math.min(...spans.map((span) => span.startUnixNano));
  const t1 = Math.max(...spans.map((span) => span.endUnixNano || span.startUnixNano), t0 + 1);
  const range = Math.max(t1 - t0, 1);
  const plotW = 640;
  const width = LABEL_W + plotW + PAD * 2;
  const height = PAD * 2 + 18 + lanes.length * LANE_H;

  return (
    <div className="waterfall">
      <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="trace waterfall">
        <text className="axis" x={LABEL_W} y={12}>0</text>
        <text className="axis" x={LABEL_W + plotW} y={12} textAnchor="end">{formatNs(range)}</text>
        {lanes.map((lane, index) => {
          const y = PAD + 18 + index * LANE_H;
          return (
            <g key={lane}>
              <text className="span-label" x={8} y={y + 14}>{lane}</text>
              <line x1={LABEL_W} x2={LABEL_W + plotW} y1={y + LANE_H - 4} y2={y + LANE_H - 4} stroke="#526d60" strokeOpacity="0.4" />
              {ordered.filter((span) => serviceName(span) === lane).map((span) => {
                const x = LABEL_W + ((span.startUnixNano - t0) / range) * plotW;
                const w = Math.max(2, ((Math.max(span.endUnixNano, span.startUnixNano) - span.startUnixNano) / range) * plotW);
                const fill = STATUS_FILL[span.status?.code ?? "unset"] ?? STATUS_FILL.unset;
                return (
                  <g key={span.spanId} className="span-hit" onClick={() => onSelect(span.spanId)}>
                    <rect
                      x={x}
                      y={y + 4}
                      width={w}
                      height={BAR_H}
                      rx={3}
                      fill={fill}
                      opacity={selected === span.spanId ? 1 : 0.82}
                      stroke={selected === span.spanId ? "#deeee5" : "transparent"}
                      aria-label={`${span.name} ${formatNs(Math.max(0, span.endUnixNano - span.startUnixNano))}`}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
