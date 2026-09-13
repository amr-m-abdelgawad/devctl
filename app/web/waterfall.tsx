import { durationNs, spanBounds, spanDurationNs } from "./format.ts";
import { ERROR_COLOR, serviceColor } from "./palette.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";
import type { SpanRow } from "./types.ts";

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
    list.sort((a, b) => spanBounds(a).start - spanBounds(b).start);
  }
  return kids;
}

type Ordered = { span: SpanRow; depth: number };

function walk(spans: SpanRow[]): Ordered[] {
  const kids = childrenOf(spans);
  const out: Ordered[] = [];
  const visit = (span: SpanRow, depth: number): void => {
    out.push({ span, depth });
    for (const child of kids.get(span.spanId) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of kids.get("") ?? []) {
    visit(root, 0);
  }
  return out;
}

const GRID = [0, 0.25, 0.5, 0.75, 1];
const MIN_BAR_PCT = 0.35;
const NAME_COL = "w-52 shrink-0 sm:w-56";
const DUR_COL = "w-14 shrink-0";
const DEPTH_PX = 12;

export function Waterfall(props: { spans: SpanRow[]; selected?: string; onSelect: (spanId: string) => void }) {
  const { spans, selected, onSelect } = props;
  if (spans.length === 0) {
    return <div className="px-2 py-6 text-sm text-muted-foreground">No spans in this trace.</div>;
  }
  const ordered = walk(spans);
  const t0 = Math.min(...spans.map((span) => spanBounds(span).start));
  const t1 = Math.max(...spans.map((span) => spanBounds(span).end), t0 + 1);
  const range = Math.max(t1 - t0, 1);
  const services = [...new Set(ordered.map(({ span }) => serviceName(span)))];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {services.map((name) => (
          <span key={name} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: serviceColor(name) }} />
            {name}
          </span>
        ))}
      </div>

      <div className="flex items-end">
        <div className={NAME_COL} />
        <div className={DUR_COL} />
        <div className="relative h-4 flex-1">
          {GRID.map((g, i) => (
            <span
              key={g}
              className={`absolute font-mono text-[10px] text-muted-foreground ${i === 0 ? "" : i === GRID.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
              style={{ left: `${g * 100}%` }}
            >
              {g === 0 ? "0" : durationNs(range * g)}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-px">
        {ordered.map(({ span, depth }) => {
          const svc = serviceName(span);
          const isError = (span.status?.code ?? "") === "error";
          const color = isError ? ERROR_COLOR : serviceColor(svc);
          const { start, end } = spanBounds(span);
          const dur = spanDurationNs(span);
          const off = ((start - t0) / range) * 100;
          const width = Math.max(MIN_BAR_PCT, ((end - start) / range) * 100);
          const isSelected = selected === span.spanId;
          return (
            <button
              key={span.spanId}
              type="button"
              onClick={() => onSelect(span.spanId)}
              className={`flex items-center rounded-md py-1 text-left transition-colors hover:bg-accent/40 ${isSelected ? "bg-accent/60" : ""}`}
            >
              <div className={`flex items-center gap-1.5 pr-3 ${NAME_COL}`} style={{ paddingLeft: depth * DEPTH_PX }}>
                <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                <span className="truncate text-xs" title={span.name}>{span.name}</span>
              </div>
              <div className={`${DUR_COL} pr-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground`}>
                {durationNs(dur)}
              </div>
              <div className="relative h-5 flex-1 overflow-hidden">
                {GRID.map((g) => (
                  <span key={g} className="absolute top-0 h-full w-px bg-border/40" style={{ left: `${g * 100}%` }} />
                ))}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={`absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[3px] ${isSelected ? "ring-2 ring-foreground/70" : ""}`}
                      style={{ left: `${off}%`, width: `${width}%`, backgroundColor: color, opacity: isSelected ? 1 : 0.9 }}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{span.name}</span>
                      <span className="flex items-center gap-1.5">
                        <Badge variant={isError ? "destructive" : "muted"}>{svc}</Badge>
                        <span className="font-mono tabular-nums">{durationNs(dur)}</span>
                        {span.kind ? <span className="text-muted-foreground">{span.kind}</span> : null}
                      </span>
                      {isError && span.status?.message ? <span className="text-destructive">{span.status.message}</span> : null}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
