import { ArrowLeft } from "lucide-react";
import { clockMs, durationMs } from "../format.ts";
import { hrefFor } from "../hash.ts";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { LlmCallRow, LlmCallsPayload } from "../types.ts";

function tokenCount(call: LlmCallRow): string {
  const total = call.usage?.total_tokens ?? ((call.usage?.prompt_tokens ?? 0) + (call.usage?.completion_tokens ?? 0));
  return total > 0 ? total.toLocaleString("en-US") : "—";
}

function costLabel(cost?: number): string {
  return cost === undefined ? "—" : `$${cost.toFixed(4)}`;
}

function pretty(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function LlmList(props: { payload?: LlmCallsPayload }) {
  const { payload } = props;
  const calls = payload?.calls ?? [];
  const errors = payload?.errors ?? [];
  if (calls.length === 0 && errors.length === 0) {
    return <Empty>No LLM calls yet. Enable llm.sources in config.</Empty>;
  }
  return (
    <div className="flex flex-col gap-3">
      {errors.map((err) => (
        <p key={err.source} className="rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          {err.source}: {err.message}
        </p>
      ))}
      {calls.length === 0 ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((call) => (
              <TableRow key={call.id}>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{clockMs(call.timestamp)}</TableCell>
                <TableCell>
                  <Badge variant={call.status === "error" ? "destructive" : "muted"}>{call.status}</Badge>
                </TableCell>
                <TableCell>
                  <a href={hrefFor("llm", call.id)} className="text-foreground hover:underline">{call.model}</a>
                </TableCell>
                <TableCell className="text-right font-mono text-[11px]">{call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{tokenCount(call)}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{costLabel(call.cost)}</TableCell>
                <TableCell className="text-muted-foreground">{call.source}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function LlmDetail(props: { call: LlmCallRow }) {
  const { call } = props;
  const attrs = Object.entries(call.attributes ?? {});
  const request = pretty(call.request);
  const response = pretty(call.response);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <Metric label="status" value={call.status} tone={call.status === "error" ? "destructive" : undefined} />
        <Metric label="latency" value={call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)} mono />
        <Metric label="tokens" value={tokenCount(call)} />
        <Metric label="cost" value={costLabel(call.cost)} />
        <Metric label="operation" value={call.operation} />
      </div>
      {call.error ? <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive">{call.error}</p> : null}
      <dl className="flex flex-col divide-y divide-border/50 text-xs">
        <Kv label="id" value={call.id} />
        <Kv label="source" value={`${call.source} (${call.source_type})`} />
        <Kv label="model" value={call.model} />
        {call.routed_model ? <Kv label="routed" value={call.routed_model} /> : null}
        {call.vendor ? <Kv label="vendor" value={call.vendor} /> : null}
        <Kv label="request id" value={call.request_id || "—"} />
        <Kv label="trace" value={call.trace_id || "—"} />
      </dl>
      {call.trace_id ? (
        <a href={hrefFor("traces", call.trace_id)} className="text-xs text-primary hover:underline">Open trace</a>
      ) : null}
      {attrs.length > 0 ? (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Attributes</h3>
          <dl className="flex flex-col divide-y divide-border/50 text-xs">
            {attrs.map(([key, value]) => (
              <Kv key={key} label={key} value={pretty(value)} />
            ))}
          </dl>
        </div>
      ) : null}
      {request !== "" ? <Payload title="Request" body={request} /> : null}
      {response !== "" ? <Payload title="Response" body={response} /> : null}
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

function Kv(props: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] gap-3 py-1.5">
      <dt className="truncate font-mono text-muted-foreground" title={props.label}>{props.label}</dt>
      <dd className="break-words font-mono text-foreground/90">{props.value}</dd>
    </div>
  );
}

function Payload(props: { title: string; body: string }) {
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</h3>
      <pre className="overflow-x-auto rounded-md bg-muted/40 p-2.5 font-mono text-[11px] text-foreground/90">{props.body}</pre>
    </div>
  );
}

export function LlmPage(props: {
  payload?: LlmCallsPayload;
  detail?: LlmCallRow;
  llmId?: string;
  error: string;
}) {
  const { payload, detail, llmId, error } = props;
  if (!llmId) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1.5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <CardTitle>LLM calls</CardTitle>
            {(payload?.calls.length ?? 0) > 0 ? <Badge variant="muted">{payload?.calls.length} recent</Badge> : null}
          </div>
          <span className="text-[11px] text-muted-foreground">LiteLLM spend logs and other configured sources</span>
        </CardHeader>
        <CardContent className="pt-0">
          {error ? <div className="mb-2 text-sm text-destructive">{error}</div> : null}
          <LlmList payload={payload} />
        </CardContent>
      </Card>
    );
  }
  const shown = detail?.id === llmId ? detail : undefined;
  return (
    <Card>
      <CardHeader className="flex-col items-start gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <a href={hrefFor("llm")} className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="size-3.5" /> llm
          </a>
          <span className="truncate font-mono text-xs text-muted-foreground" title={llmId}>{llmId}</span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {error ? <div className="mb-2 text-sm text-destructive">{error}</div> : null}
        {shown ? <LlmDetail call={shown} /> : <Empty>Loading call…</Empty>}
      </CardContent>
    </Card>
  );
}
