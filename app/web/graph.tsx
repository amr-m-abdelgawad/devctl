import { useMemo, useState } from "react";
import { cn } from "./lib/utils.ts";
import { serviceColor } from "./palette.ts";
import { Empty } from "./components/primitives.tsx";
import { StatusBadge, StatusDot, toneColor, toneOf } from "./components/status.tsx";
import { Badge } from "./components/ui/badge.tsx";
import type { ConfigService, ServiceRow } from "./types.ts";
import { isLiveState, type RunControl } from "./control.ts";
import { ActionButtons, EnvSelect } from "./components/controls.tsx";

const NODE_W = 208;
const NODE_H = 82;
const COL_GAP = 120;
const ROW_GAP = 44;
const PAD_X = 32;
const PAD_Y = 40;
const LANE_PAD = 14;
const ARROW_INSET = 8;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 240;

type Point = { x: number; y: number };
type Edge = { from: string; to: string; condition: string };

function depName(dep: ConfigService["dependencies"][number]): string {
  return typeof dep === "string" ? dep : dep.service;
}

function depCondition(dep: ConfigService["dependencies"][number]): string {
  return typeof dep === "string" ? "" : (dep.condition ?? "");
}

function layers(services: ConfigService[]): string[][] {
  const names = services.map((svc) => svc.name);
  const known = new Set(names);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const name of names) {
    incoming.set(name, 0);
    outgoing.set(name, []);
  }
  for (const svc of services) {
    for (const dep of svc.dependencies) {
      const from = depName(dep);
      if (known.has(from) && from !== svc.name) {
        outgoing.get(from)?.push(svc.name);
        incoming.set(svc.name, (incoming.get(svc.name) ?? 0) + 1);
      }
    }
  }
  const levels: string[][] = [];
  let frontier = names.filter((name) => (incoming.get(name) ?? 0) === 0).sort();
  const placed = new Set<string>();
  while (frontier.length > 0) {
    levels.push(frontier);
    for (const name of frontier) {
      placed.add(name);
    }
    const next: string[] = [];
    for (const name of frontier) {
      for (const child of outgoing.get(name) ?? []) {
        const left = (incoming.get(child) ?? 1) - 1;
        incoming.set(child, left);
        if (left === 0 && !placed.has(child)) {
          next.push(child);
        }
      }
    }
    frontier = [...new Set(next)].sort();
  }
  const leftover = names.filter((name) => !placed.has(name));
  if (leftover.length > 0) {
    levels.push(leftover);
  }
  return levels;
}

function layout(cols: string[][]): { positions: Map<string, Point>; width: number; height: number } {
  const colHeights = cols.map((col) => Math.max(col.length, 1) * (NODE_H + ROW_GAP) - ROW_GAP);
  const stack = Math.max(...colHeights, NODE_H);
  const positions = new Map<string, Point>();
  cols.forEach((col, ci) => {
    const extra = (stack - (colHeights[ci] ?? stack)) / 2;
    col.forEach((name, ri) => {
      positions.set(name, {
        x: PAD_X + ci * (NODE_W + COL_GAP),
        y: PAD_Y + extra + ri * (NODE_H + ROW_GAP),
      });
    });
  });
  const width = PAD_X * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * COL_GAP;
  const height = PAD_Y * 2 + stack;
  return { positions, width, height };
}

function edgePath(a: Point, b: Point): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x - ARROW_INSET;
  const y2 = b.y + NODE_H / 2;
  if (x2 >= x1) {
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  const bulge = COL_GAP / 2;
  return `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 - bulge} ${y2}, ${x2} ${y2}`;
}

function svgId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  const n = parseInt(raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw, 16);
  if (Number.isNaN(n)) {
    return hex;
  }
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function healthValue(state: string, health: string): string {
  const h = health.trim();
  const s = state.trim();
  if (s.toLowerCase() === "failed" || h.toLowerCase() === "unhealthy") {
    return h || s || "unhealthy";
  }
  return h || s || "unknown";
}

function portLabel(row: ServiceRow | undefined, svc: ConfigService): string {
  const live = Object.entries(row?.ports ?? {});
  if (live.length > 0) {
    return live.map(([name, port]) => `${name}:${port}`).join("  ");
  }
  const specs = (svc.ports ?? []).filter((port) => !port.auto && port.value > 0);
  if (specs.length > 0) {
    return specs.map((port) => `${port.name}:${port.value}`).join("  ");
  }
  return svc.container?.image ?? "";
}

function blurb(svc: ConfigService): string {
  const text = svc.description.trim();
  if (text !== "") {
    const cut = text.split(/[.—]/)[0]?.trim() ?? text;
    return cut;
  }
  if (svc.container?.image) {
    return svc.container.image;
  }
  return "configured service";
}

function rankLabel(index: number, total: number): string {
  if (total <= 1) {
    return "services";
  }
  if (index === 0) {
    return "upstream";
  }
  if (index === total - 1) {
    return "downstream";
  }
  if (total === 3) {
    return "midstream";
  }
  return `rank ${index + 1}`;
}

function neighbors(name: string, edges: Edge[]): Set<string> {
  const related = new Set<string>([name]);
  for (const edge of edges) {
    if (edge.from === name || edge.to === name) {
      related.add(edge.from);
      related.add(edge.to);
    }
  }
  return related;
}

export function DependencyGraph(props: {
  readonly config: ConfigService[];
  readonly services: ServiceRow[];
  readonly busy?: boolean;
  readonly onControl?: RunControl;
}) {
  const { config, services, busy = false, onControl } = props;
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const runtime = useMemo(() => new Map(services.map((row) => [row.name, row])), [services]);
  const cols = useMemo(() => layers(config), [config]);
  const { positions, width, height } = useMemo(() => layout(cols), [cols]);
  const edges = useMemo(() => {
    const list: Edge[] = [];
    for (const svc of config) {
      for (const dep of svc.dependencies) {
        const from = depName(dep);
        if (positions.has(from) && positions.has(svc.name)) {
          list.push({ from, to: svc.name, condition: depCondition(dep) });
        }
      }
    }
    return list;
  }, [config, positions]);

  if (config.length === 0) {
    return <Empty>No services in config.</Empty>;
  }

  const focus = hover ?? selected;
  const related = focus ? neighbors(focus, edges) : null;
  const selectedSvc = config.find((svc) => svc.name === selected);
  const canvasW = Math.max(width, MIN_WIDTH);
  const canvasH = Math.max(height, MIN_HEIGHT);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">Depends-on flows left to right. Hover a node to isolate its neighborhood.</p>
        <TopologyLegend />
      </div>
      <div className="topology-canvas overflow-x-auto rounded-lg border border-border/60 bg-muted/40">
        <div className="relative mx-auto" style={{ width: canvasW, height: canvasH }}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={canvasW}
            height={canvasH}
            className="absolute inset-0"
            role="img"
            aria-label="service dependency graph"
          >
            <defs>
              <marker id="topo-arrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M 0 1.4 L 10 5 L 0 8.6 Z" fill="var(--muted-foreground)" />
              </marker>
              <marker id="topo-arrow-live" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M 0 1.4 L 10 5 L 0 8.6 Z" fill="var(--primary)" />
              </marker>
              {edges.map((edge) => {
                const a = positions.get(edge.from);
                const b = positions.get(edge.to);
                if (!a || !b) {
                  return null;
                }
                const id = `topo-grad-${svgId(edge.from)}-${svgId(edge.to)}`;
                return (
                  <linearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1={a.x + NODE_W} y1={a.y + NODE_H / 2} x2={b.x - ARROW_INSET} y2={b.y + NODE_H / 2}>
                    <stop offset="0%" stopColor={serviceColor(edge.from)} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={serviceColor(edge.to)} stopOpacity={0.45} />
                  </linearGradient>
                );
              })}
            </defs>
            {cols.map((col, ci) => {
              const first = positions.get(col[0] ?? "");
              if (!first) {
                return null;
              }
              return (
                <g key={`lane-${ci}`}>
                  <rect
                    x={first.x - LANE_PAD}
                    y={PAD_Y - 26}
                    width={NODE_W + LANE_PAD * 2}
                    height={canvasH - PAD_Y + 10}
                    rx={18}
                    fill="var(--card)"
                    fillOpacity={0.28}
                    stroke="var(--border)"
                    strokeOpacity={0.45}
                  />
                  <text x={first.x} y={PAD_Y - 10} fill="var(--muted-foreground)" fontSize={10} letterSpacing={1.4}>
                    {rankLabel(ci, cols.length).toUpperCase()}
                  </text>
                </g>
              );
            })}
            {edges.map((edge) => {
              const a = positions.get(edge.from);
              const b = positions.get(edge.to);
              if (!a || !b) {
                return null;
              }
              const incident = focus !== null && (edge.from === focus || edge.to === focus);
              const dimmed = focus !== null && !incident;
              const fromRt = runtime.get(edge.from);
              const toRt = runtime.get(edge.to);
              const live = toneOf(healthValue(fromRt?.state ?? "", fromRt?.health ?? "")) === "success"
                && toneOf(healthValue(toRt?.state ?? "", toRt?.health ?? "")) === "success";
              const grad = `url(#topo-grad-${svgId(edge.from)}-${svgId(edge.to)})`;
              const d = edgePath(a, b);
              return (
                <g key={`${edge.from}-${edge.to}`} className={cn("transition-opacity duration-150", dimmed && "opacity-15")}>
                  <path d={d} fill="none" stroke={grad} strokeWidth={incident ? 2.6 : 1.7} markerEnd={incident || live ? "url(#topo-arrow-live)" : "url(#topo-arrow)"} opacity={0.9} />
                  {live ? <path d={d} fill="none" stroke="var(--primary)" strokeWidth={1.1} className="topology-flow" opacity={incident ? 0.9 : 0.45} /> : null}
                </g>
              );
            })}
          </svg>

          {config.map((svc) => {
            const pos = positions.get(svc.name);
            if (!pos) {
              return null;
            }
            const rt = runtime.get(svc.name);
            const health = healthValue(rt?.state ?? "", rt?.health ?? "");
            const accent = serviceColor(svc.name);
            const dimmed = related !== null && !related.has(svc.name);
            const active = selected === svc.name || hover === svc.name;
            const failed = toneOf(health) === "destructive";
            const starting = toneOf(health) === "warning";
            return (
              <button
                key={svc.name}
                type="button"
                aria-pressed={selected === svc.name}
                onMouseEnter={() => setHover(svc.name)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(svc.name)}
                onBlur={() => setHover(null)}
                onClick={() => setSelected((cur) => (cur === svc.name ? null : svc.name))}
                className={cn(
                  "absolute flex overflow-hidden rounded-lg border bg-card text-left shadow-sm outline-none transition-[opacity,box-shadow,transform] duration-150",
                  "hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring",
                  dimmed && "opacity-30",
                )}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: NODE_W,
                  height: NODE_H,
                  borderColor: failed ? toneColor(health) : active ? accent : undefined,
                  boxShadow: active
                    ? `0 0 0 1px ${accent}, 0 10px 28px ${withAlpha(accent, 0.22)}`
                    : failed
                      ? `0 0 0 1px ${toneColor(health)}, 0 8px 20px ${withAlpha(toneColor(health), 0.18)}`
                      : undefined,
                }}
              >
                <span className="w-1 shrink-0 self-stretch" style={{ backgroundColor: accent }} />
                <span className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold tracking-tight">{svc.name}</span>
                    <StatusDot value={health} pulse={starting} />
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">{blurb(svc)}</span>
                  <span className="mt-auto flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                    <span className="truncate uppercase tracking-wide">{rt?.state || "configured"}</span>
                    <span className="truncate">{portLabel(rt, svc)}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {selectedSvc ? (
        <TopologyInspector
          svc={selectedSvc}
          row={runtime.get(selectedSvc.name)}
          edges={edges}
          busy={busy}
          onSelect={setSelected}
          onControl={onControl}
        />
      ) : null}
    </div>
  );
}

function TopologyLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
      <span className="flex items-center gap-1.5"><StatusDot value="healthy" />healthy</span>
      <span className="flex items-center gap-1.5"><StatusDot value="starting" />starting</span>
      <span className="flex items-center gap-1.5"><StatusDot value="failed" />failed</span>
      <span className="flex items-center gap-1.5"><StatusDot value="stopped" />stopped</span>
    </div>
  );
}

function TopologyInspector(props: {
  readonly svc: ConfigService;
  readonly row: ServiceRow | undefined;
  readonly edges: Edge[];
  readonly busy: boolean;
  readonly onSelect: (name: string) => void;
  readonly onControl?: RunControl;
}) {
  const { svc, row, edges, busy, onSelect, onControl } = props;
  const upstream = edges.filter((edge) => edge.to === svc.name);
  const downstream = edges.filter((edge) => edge.from === svc.name);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-elevated/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="size-2 rounded-full" style={{ backgroundColor: serviceColor(svc.name) }} />
        <span className="text-sm font-semibold">{svc.name}</span>
        <StatusBadge value={row?.state || "configured"} />
        {row?.health && row.health.toLowerCase() !== (row.state || "").toLowerCase() ? (
          <StatusBadge value={row.health} />
        ) : null}
        {portLabel(row, svc) ? <span className="font-mono text-[11px] text-muted-foreground">{portLabel(row, svc)}</span> : null}
        {row && onControl ? <EnvSelect row={row} busy={busy} onControl={onControl} /> : null}
        {onControl ? (
          <div className="ml-auto">
            <ActionButtons
              live={isLiveState(row?.state ?? "")}
              busy={busy}
              onStart={() => onControl("start_services", { services: [svc.name] }, `Starting ${svc.name}…`)}
              onStop={() => onControl("stop_services", { services: [svc.name] }, `Stopping ${svc.name}…`)}
              onRestart={() => onControl("restart_services", { services: [svc.name] }, `Restarting ${svc.name}…`)}
            />
          </div>
        ) : null}
      </div>
      {svc.description ? <p className="text-[12px] text-muted-foreground">{svc.description}</p> : null}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <DepList label="depends on" items={upstream} pick="from" fallback="none" onSelect={onSelect} />
        <DepList label="dependents" items={downstream} pick="to" fallback="none" onSelect={onSelect} />
      </div>
      {row?.last_error ? (
        <p className="font-mono text-[11px] text-destructive">{row.last_error}</p>
      ) : null}
    </div>
  );
}

function DepList(props: {
  readonly label: string;
  readonly items: Edge[];
  readonly pick: "from" | "to";
  readonly fallback: string;
  readonly onSelect: (name: string) => void;
}) {
  const { label, items, pick, fallback, onSelect } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      {items.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">{fallback}</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((edge) => {
            const name = edge[pick];
            return (
              <button key={`${pick}-${name}`} type="button" onClick={() => onSelect(name)}>
                <Badge variant="muted" className="gap-1.5">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: serviceColor(name) }} />
                  {name}
                  {edge.condition ? <span className="text-[10px] opacity-70">{edge.condition}</span> : null}
                </Badge>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
