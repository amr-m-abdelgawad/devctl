import { useEffect, useState } from "react";
import { fetchDock } from "../api.ts";
import { ArticleIcon, ArrowsOutSimpleIcon, BrowsersIcon, SquaresFourIcon } from "../icons.ts";
import type { DockCard, DockMetric, DockPayload } from "../types.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { cn } from "../lib/utils.ts";

const FALLBACK_REFRESH_SECONDS = 15;
const MIN_REFRESH_SECONDS = 5;
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

export function OverviewDock() {
  const [payload, setPayload] = useState<DockPayload | undefined>();
  const [openId, setOpenId] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const schedule = (seconds: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void tick();
      }, Math.max(MIN_REFRESH_SECONDS, seconds) * 1000);
    };
    const tick = async (): Promise<void> => {
      if (document.hidden) {
        schedule(FALLBACK_REFRESH_SECONDS);
        return;
      }
      try {
        const next = await fetchDock();
        if (cancelled) {
          return;
        }
        setPayload(next);
        schedule(next.refresh_seconds || FALLBACK_REFRESH_SECONDS);
      } catch {
        if (!cancelled) {
          schedule(FALLBACK_REFRESH_SECONDS);
        }
      }
    };
    const onVisible = (): void => {
      if (!document.hidden) {
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const items = payload?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  const selected = items.find((item) => item.id === openId);
  return (
    <section aria-label="Dock" className="mx-auto w-full max-w-5xl">
      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <SquaresFourIcon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold leading-none">Dock</h2>
              <p className="mt-1 truncate text-xs text-muted-foreground">Pinned from web.dock in .devctl</p>
            </div>
          </div>
          <Badge variant="muted">{items.length === 1 ? "1 panel" : `${items.length} panels`}</Badge>
        </div>
        <div
          className={cn(
            "grid gap-3 p-3",
            items.length === 1 && "mx-auto w-full max-w-xl",
            items.length > 1 && "sm:grid-cols-2",
          )}
        >
          {items.map((item) => (
            <DockTile key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
          ))}
        </div>
      </div>
      <Dialog open={selected !== undefined} onOpenChange={(open) => { if (!open) setOpenId(undefined); }}>
        {selected ? <DockDialog item={selected} /> : null}
      </Dialog>
    </section>
  );
}

function DockTile(props: { item: DockCard; onOpen: () => void }) {
  const { item, onOpen } = props;
  const embed = item.kind === "iframe";
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            {embed ? <BrowsersIcon className="size-3.5" aria-hidden="true" /> : <ArticleIcon className="size-3.5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium" title={item.title}>{item.title}</h3>
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={item.source || undefined}>
              {item.source || (embed ? "Page" : "Text")}
            </p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          <ArrowsOutSimpleIcon data-icon="inline-start" />
          Full screen
        </Button>
      </div>
      <DockPreview item={item} onOpen={onOpen} />
      {item.metrics_error ? <p className="text-[11px] text-muted-foreground">{item.metrics_error}</p> : null}
      {item.truncated ? <p className="text-[11px] text-muted-foreground">Showing the first part of the response.</p> : null}
    </article>
  );
}

function DockPreview(props: { item: DockCard; onOpen: () => void }) {
  const { item, onOpen } = props;
  if (item.kind === "iframe" && item.url) {
    return (
      <button type="button" onClick={onOpen} className="relative block overflow-hidden rounded-lg border bg-muted/20 text-left" aria-label={`Open ${item.title} full screen`}>
        <iframe
          title={item.title}
          src={item.url}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          tabIndex={-1}
          className="pointer-events-none h-56 w-full bg-background"
        />
      </button>
    );
  }
  if (item.metrics && item.metrics.length > 0) {
    return (
      <button type="button" onClick={onOpen} className="block w-full rounded-lg text-left" aria-label={`Open ${item.title} full screen`}>
        <DockMetrics metrics={item.metrics} />
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} className="relative block h-56 w-full overflow-hidden rounded-lg border bg-muted/20 px-3 py-3 text-left" aria-label={`Open ${item.title} full screen`}>
      <span className={cn("block whitespace-pre-wrap text-[13px] leading-relaxed", isMonospace(item.text) && "font-mono text-[12px]")}>
        {item.text || item.error || "Waiting for a response."}
      </span>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />
    </button>
  );
}

function DockDialog(props: { item: DockCard }) {
  const { item } = props;
  return (
    <DialogContent className="flex h-[92dvh] w-[min(1100px,96vw)] max-w-none flex-col gap-3 overflow-hidden p-4 sm:max-w-none">
      <DialogHeader className="pr-8">
        <DialogTitle>{item.title}</DialogTitle>
        <DialogDescription>{item.error || item.source || "Dock panel"}</DialogDescription>
      </DialogHeader>
      {item.metrics && item.metrics.length > 0 ? (
        <div className="shrink-0">
          <DockMetrics metrics={item.metrics} wide />
          {item.metrics_error ? <p className="mt-2 text-xs text-muted-foreground">{item.metrics_error}</p> : null}
        </div>
      ) : null}
      {item.kind === "iframe" && item.url ? (
        <iframe
          title={item.title}
          src={item.url}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 rounded-lg border bg-background"
        />
      ) : (
        <pre className={cn("min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 p-4 whitespace-pre-wrap text-[13px] leading-relaxed", isMonospace(item.text) && "font-mono text-[12px]")}>
          {item.text || item.error || "Waiting for a response."}
        </pre>
      )}
    </DialogContent>
  );
}

function DockMetrics(props: { metrics: DockMetric[]; wide?: boolean }) {
  const { metrics, wide = false } = props;
  return (
    <div
      className={cn(
        "grid gap-2",
        metrics.length === 1 && "grid-cols-1",
        metrics.length > 1 && "grid-cols-2",
        wide && metrics.length > 2 && "sm:grid-cols-3",
      )}
    >
      {metrics.map((metric) => (
        <div key={metric.key} className="metric-tile min-w-0 rounded-lg border bg-card px-3 py-3">
          <div className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" title={metric.label}>
            {metric.label}
          </div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className={cn("text-[22px] font-semibold leading-none tabular-nums", metric.missing && "text-muted-foreground")}>
              {metric.value}
            </span>
            {metric.unit ? <span className="text-[11px] text-muted-foreground">{metric.unit}</span> : null}
          </div>
          {metric.missing ? <div className="mt-1 text-[11px] text-muted-foreground">Not in the response</div> : null}
        </div>
      ))}
    </div>
  );
}

function isMonospace(text: string | undefined): boolean {
  const start = text?.trimStart()[0];
  return start === "{" || start === "[";
}
