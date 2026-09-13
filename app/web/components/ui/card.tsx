import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 rounded-xl border bg-card text-card-foreground shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-between gap-3 px-4 pb-2 pt-3.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4 pb-4", className)} {...props} />;
}
