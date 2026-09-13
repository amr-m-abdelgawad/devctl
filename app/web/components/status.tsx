import { Badge, type BadgeProps } from "./ui/badge.tsx";
import { cn } from "../lib/utils.ts";

export type Tone = "success" | "warning" | "destructive" | "info" | "muted";

const TONE_VAR: Record<Tone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--danger)",
  info: "var(--info)",
  muted: "var(--muted-foreground)",
};

/** Map a service/health state or a log level to a semantic tone. */
export function toneOf(value: string): Tone {
  const v = value.toLowerCase();
  if (v === "healthy" || v === "running" || v === "ok" || v === "up") {
    return "success";
  }
  if (v === "unhealthy" || v === "degraded" || v === "warn" || v === "warning" || v === "starting" || v === "restarting" || v === "debug") {
    return "warning";
  }
  if (v === "failed" || v === "fatal" || v === "error" || v === "crashed") {
    return "destructive";
  }
  if (v === "info" || v === "trace" || v === "notice") {
    return "info";
  }
  return "muted";
}

/** The raw CSS color for a tone — for rails, dots, and SVG fills. */
export function toneColor(value: string): string {
  return TONE_VAR[toneOf(value)];
}

/** A small filled dot in the tone color. */
export function StatusDot({ value, className, pulse }: { value: string; className?: string; pulse?: boolean }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", pulse && "animate-pulse", className)}
      style={{ backgroundColor: toneColor(value) }}
    />
  );
}

/** A tinted status pill with a leading dot: HEALTHY, ERROR, INFO, … */
export function StatusBadge({ value, className }: { value: string; className?: string }) {
  const tone = toneOf(value);
  const variant = (tone === "muted" ? "muted" : tone) as BadgeProps["variant"];
  return (
    <Badge variant={variant} className={cn("gap-1.5 pl-1.5 font-mono text-[10px] uppercase tracking-wide", className)}>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: toneColor(value) }} />
      {value}
    </Badge>
  );
}
