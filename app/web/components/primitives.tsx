import type { ReactNode } from "react";
import { hrefFor } from "../hash.ts";
import { cn } from "../lib/utils.ts";
import type { Tone } from "./status.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
  muted: "text-foreground",
};

/** A single metric tile for the overview KPI strip. */
export function Kpi(props: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  const { label, value, unit, sub, tone = "muted", icon } = props;
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
        {icon ? <span className="text-muted-foreground/70">{icon}</span> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className={cn("text-[26px] font-semibold leading-none tabular-nums", TONE_TEXT[tone])}>{value}</span>
        {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-1.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/** Empty-state text inside a panel. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-center px-2 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

/** A truncated, monospace trace id that links to its trace, full id on hover. */
export function TraceLink({ id }: { id: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={hrefFor("traces", id)}
          className="rounded font-mono text-xs text-primary/90 underline-offset-4 hover:text-primary hover:underline"
        >
          {id.slice(0, 10)}
        </a>
      </TooltipTrigger>
      <TooltipContent><span className="font-mono">{id}</span></TooltipContent>
    </Tooltip>
  );
}
