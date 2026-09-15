import { ArrowLeftIcon } from "../icons.ts";
import { durationNs, NANOS_PER_MS, spanDurationNs, traceEnvelopeNs } from "../format.ts";
import { hrefFor } from "../hash.ts";
import { serviceColor } from "../palette.ts";
import { LogTable, RequestTable } from "../components/tables.tsx";
import { Empty } from "../components/primitives.tsx";
import { toneColor } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { RequestRow, RequestsPayload, SpanRow, TracePayload } from "../types.ts";
import { Waterfall } from "../waterfall.tsx";

function serviceName(span: SpanRow): string {
  const name = span.resource["service.name"];
  return typeof name === "string" && name !== "" ? name : "unknown";
}

function proxyHopNs(spans: SpanRow[]): number | undefined {
  const hops = spans.filter((span) => serviceName(span) === "proxy");
  if (hops.length === 0) {
    return undefined;
  }
  return Math.max(...hops.map(spanDurationNs));
}

function TraceSummary(props: { trace: TracePayload; proxy?: RequestRow }) {
  const { trace, proxy } = props;
  const spans = trace.spans;
  const traceNs = traceEnvelopeNs(spans);
  const services = new Set(spans.map(serviceName));
  const errors = spans.filter((s) => (s.status?.code ?? "") === "error").length;
  const fromRequest = typeof proxy?.duration_ms === "number" ? proxy.duration_ms * NANOS_PER_MS : undefined;
  const proxyNs = fromRequest ?? proxyHopNs(spans);
  const showProxy = proxyNs !== undefined && Math.abs(proxyNs - traceNs) >= NANOS_PER_MS;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <Metric label="trace" value={durationNs(traceNs)} mono />
      {proxyNs !== undefined && showProxy ? <Metric label="proxy hop" value={durationNs(proxyNs)} mono /> : null}
      <Metric label="spans" value={String(spans.length)} />
      <Metric label="services" value={String(services.size)} />
      <Metric label="errors" value={String(errors)} tone={errors > 0 ? "destructive" : undefined} />
    </div>
  );
}

function Metric(props: { label: string; value: string; mono?: boolean; tone?: "destructive" }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-sm font-semibold tabular-nums ${props.tone === "destructive" ? "text-destructive" : "text-foreground"} ${props.mono ? "font-mono" : ""}`}>{props.value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</span>
    </div>
  );
}

function SpanDetail(props: { span?: SpanRow }) {
  const { span } = props;
  if (!span) {
    return <Empty>Select a span to inspect its attributes.</Empty>;
  }
  const svc = serviceName(span);
  const dur = spanDurationNs(span);
  const attrs = Object.entries(span.attributes ?? {});
  const isError = (span.status?.code ?? "") === "error";
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: isError ? toneColor("error") : serviceColor(svc) }} />
          <span className="break-all text-sm font-medium">{span.name}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="muted">{svc}</Badge>
          {span.kind ? <Badge variant="outline" className="text-[10px]">{span.kind}</Badge> : null}
          <Badge variant="outline" className="font-mono text-[10px]">{durationNs(dur)}</Badge>
          {isError ? <Badge variant="destructive">error</Badge> : null}
        </div>
      </div>
      {isError && span.status?.message ? (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive">{span.status.message}</p>
      ) : null}
      {attrs.length > 0 ? (
        <dl className="flex flex-col divide-y divide-border/50 text-xs">
          {attrs.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] gap-3 py-1.5">
              <dt className="truncate font-mono text-muted-foreground" title={key}>{key}</dt>
              <dd className="break-words font-mono text-foreground/90">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-xs text-muted-foreground">No attributes.</p>}
    </div>
  );
}

export function TracesPage(props: {
  requests?: RequestsPayload;
  requestTotal?: number;
  trace?: TracePayload;
  traceId?: string;
  error: string;
  selectedSpan: string;
  onSelectSpan: (id: string) => void;
  onJumpRequest: (id: string) => void;
  traceMsById?: Record<string, number>;
}) {
  const { requests, requestTotal, trace, traceId, error, selectedSpan, onSelectSpan, onJumpRequest, traceMsById } = props;
  const recent = requests?.requests.length ?? 0;
  const total = requestTotal ?? requests?.total ?? 0;

  if (!traceId) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1.5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <CardTitle>Recent traces</CardTitle>
            {recent > 0 ? <Badge variant="muted">{total > recent ? `${recent} of ${total.toLocaleString("en-US")}` : `${recent} recent`}</Badge> : null}
          </div>
          <span className="text-[11px] text-muted-foreground">duration is the full pipeline; proxy hop is the HTTP call through the reverse proxy</span>
        </CardHeader>
        <CardContent className="pt-0">
          {error ? <div className="mb-2 text-sm text-destructive">{error}</div> : null}
          <RequestTable requests={requests?.requests ?? []} onJumpRequest={onJumpRequest} traceMsById={traceMsById} />
        </CardContent>
      </Card>
    );
  }

  const shown = trace?.trace_id === traceId ? trace : undefined;
  const span = shown?.spans.find((s) => s.spanId === selectedSpan);
  const spanLogs = selectedSpan ? (shown?.logs ?? []).filter((row) => row.spanId === selectedSpan) : (shown?.logs ?? []);
  const proxy = traceId ? requests?.requests.find((row) => row.trace_id === traceId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-col items-start gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <a href={hrefFor("traces")} className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ArrowLeftIcon size={14} className="size-3.5" /> traces
            </a>
            <span className="truncate font-mono text-xs text-muted-foreground" title={traceId}>{traceId}</span>
          </div>
          {shown ? <TraceSummary trace={shown} proxy={proxy} /> : null}
        </CardHeader>
        <CardContent className="pt-0">
          {error ? <div className="mb-2 text-sm text-destructive">{error}</div> : null}
          {shown ? <Waterfall spans={shown.spans} selected={selectedSpan} onSelect={onSelectSpan} /> : <Empty>Loading trace…</Empty>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.9fr]">
        <Card>
          <CardHeader><CardTitle>Span detail</CardTitle></CardHeader>
          <CardContent className="pt-0"><SpanDetail span={span} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Correlated logs</CardTitle>
            {selectedSpan ? <Badge variant="muted">selected span</Badge> : shown ? <Badge variant="muted">whole trace</Badge> : null}
          </CardHeader>
          <CardContent className="pt-0"><LogTable events={spanLogs} showTrace={false} /></CardContent>
        </Card>
      </div>
    </div>
  );
}
