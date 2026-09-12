import type { ConfigService, ServiceRow } from "./types.ts";

const NODE_W = 140;
const NODE_H = 36;
const COL_GAP = 80;
const ROW_GAP = 28;
const PAD = 24;

function depName(dep: ConfigService["dependencies"][number]): string {
  return typeof dep === "string" ? dep : dep.service;
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
      if (!known.has(from) || from === svc.name) {
        continue;
      }
      outgoing.get(from)?.push(svc.name);
      incoming.set(svc.name, (incoming.get(svc.name) ?? 0) + 1);
    }
  }
  const levels: string[][] = [];
  let frontier = names.filter((name) => (incoming.get(name) ?? 0) === 0).sort();
  const placed = new Set<string>();
  while (frontier.length > 0) {
    levels.push(frontier);
    frontier.forEach((name) => placed.add(name));
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

function tone(state: string, health: string): string {
  if (state === "failed" || health === "unhealthy") {
    return "#f28b91";
  }
  if (health === "healthy" || state === "running") {
    return "#91d6a0";
  }
  if (state === "starting") {
    return "#e8c586";
  }
  return "#526d60";
}

export function DependencyGraph(props: { config: ConfigService[]; services: ServiceRow[] }) {
  const { config, services } = props;
  if (config.length === 0) {
    return <div className="empty">No services in config.</div>;
  }
  const runtime = new Map(services.map((row) => [row.name, row]));
  const cols = layers(config);
  const positions = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => {
    col.forEach((name, ri) => {
      positions.set(name, { x: PAD + ci * (NODE_W + COL_GAP), y: PAD + ri * (NODE_H + ROW_GAP) });
    });
  });
  const width = PAD * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * COL_GAP;
  const height = PAD * 2 + Math.max(...cols.map((col) => col.length), 1) * (NODE_H + ROW_GAP) - ROW_GAP;
  const edges: Array<{ from: string; to: string }> = [];
  for (const svc of config) {
    for (const dep of svc.dependencies) {
      const from = depName(dep);
      if (positions.has(from) && positions.has(svc.name)) {
        edges.push({ from, to: svc.name });
      }
    }
  }
  return (
    <div className="graph-wrap">
      <svg width={Math.max(width, 320)} height={Math.max(height, 120)} role="img" aria-label="service dependency graph">
        {edges.map((edge) => {
          const a = positions.get(edge.from);
          const b = positions.get(edge.to);
          if (!a || !b) {
            return null;
          }
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return <path key={`${edge.from}-${edge.to}`} className="edge" d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} />;
        })}
        {config.map((svc) => {
          const pos = positions.get(svc.name);
          if (!pos) {
            return null;
          }
          const rt = runtime.get(svc.name);
          const fill = tone(rt?.state ?? "", rt?.health ?? "");
          return (
            <g key={svc.name} transform={`translate(${pos.x}, ${pos.y})`}>
              <rect width={NODE_W} height={NODE_H} rx={8} fill="#293b32" stroke={fill} />
              <circle cx={14} cy={NODE_H / 2} r={5} fill={fill} />
              <text className="node-label" x={26} y={22}>{svc.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
