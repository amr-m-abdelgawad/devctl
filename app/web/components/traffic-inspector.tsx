import { useState } from "react";
import { durationMs } from "../format.ts";
import { hrefFor } from "../hash.ts";
import { trafficIsError, trafficPayloadView, trafficStatusLabel, type TrafficBodyMode } from "../traffic.ts";
import { cn } from "../lib/utils.ts";
import { CopyTextButton, JsonViewer } from "./json-viewer.tsx";
import { Empty, TraceLink } from "./primitives.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import type { TrafficCallRow } from "../types.ts";

const BODY_MODE_KEY = "devctl.traffic.bodyMode";

function persistBodyMode(mode: TrafficBodyMode): void {
  try {
    window.localStorage.setItem(BODY_MODE_KEY, mode);
  } catch {
    return;
  }
}

export function useTrafficBodyMode(): [TrafficBodyMode, (mode: TrafficBodyMode) => void] {
  const [mode, setMode] = useState<TrafficBodyMode>(() => {
    try {
      return window.localStorage.getItem(BODY_MODE_KEY) === "raw" ? "raw" : "json";
    } catch {
      return "json";
    }
  });
  const onMode = (next: TrafficBodyMode): void => {
    setMode(next);
    persistBodyMode(next);
  };
  return [mode, onMode];
}

export function TrafficInspector(props: {
  call?: TrafficCallRow;
  loading: boolean;
  bodyMode: TrafficBodyMode;
  onBodyMode: (mode: TrafficBodyMode) => void;
}) {
  const { call, loading, bodyMode, onBodyMode } = props;
  const [find, setFind] = useState("");
  const [wrapJson, setWrapJson] = useState(true);
  if (!call) {
    return <Empty>{loading ? "Loading hop…" : "Select a proxied hop to inspect the request and response."}</Empty>;
  }
  const needle = find.trim();
  const request = trafficPayloadView(call.request, bodyMode);
  const response = trafficPayloadView(call.response, bodyMode);
  const traceId = call.trace_id?.trim() ?? "";
  const error = trafficIsError(call);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={error ? "destructive" : "success"}>{trafficStatusLabel(call)}</Badge>
        <Badge variant="info">{call.transport}</Badge>
        {call.duration_ms === undefined ? null : <Badge variant="muted">{durationMs(call.duration_ms)}</Badge>}
        {call.request?.truncated || call.response?.truncated ? <Badge variant="warning">truncated</Badge> : null}
        {call.request?.omitted || call.response?.omitted ? <Badge variant="outline">omitted</Badge> : null}
      </div>
      <dl className="flex flex-col gap-1 text-xs">
        <Kv label="caller" value={call.caller || "—"} />
        <Kv label="route" value={`${call.route} (${call.transport})`} />
        <Kv label="method" value={`${call.method} ${call.path}`} />
        <Kv label="request" value={call.request_id || call.id} />
        {traceId !== "" ? (
          <div className="flex items-baseline gap-2">
            <dt className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">trace</dt>
            <dd><TraceLink id={traceId} /></dd>
          </div>
        ) : null}
      </dl>
      {traceId !== "" ? (
        <a href={hrefFor("traces", traceId)} className="w-fit text-xs text-primary hover:underline">Open trace</a>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="inline-flex w-fit rounded-md border border-border/70 bg-muted/40 p-0.5">
          <ModeTab label="JSON" active={bodyMode === "json"} onClick={() => onBodyMode("json")} />
          <ModeTab label="Raw" active={bodyMode === "raw"} onClick={() => onBodyMode("raw")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyTextButton text={[request, response].filter((part) => part !== "").join("\n\n")} label="Copy" />
          <Button type="button" size="xs" variant={wrapJson ? "secondary" : "ghost"} onClick={() => setWrapJson((value) => !value)}>
            {wrapJson ? "Unwrap" : "Wrap"}
          </Button>
          <label className="min-w-[10rem] flex-1">
            <span className="sr-only">Find in payload</span>
            <input
              type="search"
              value={find}
              onChange={(event) => setFind(event.currentTarget.value)}
              placeholder="Find in body"
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {request === "" && response === "" ? (
          <Empty>{loading ? "Loading payload…" : "No request/response body."}</Empty>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <JsonViewer title="Request" input={request} wrap={wrapJson} needle={needle} parseStrings={bodyMode !== "raw"} />
            <JsonViewer title="Response" input={response} wrap={wrapJson} needle={needle} parseStrings={bodyMode !== "raw"} />
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTab(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        props.active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

function Kv(props: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-all font-mono text-foreground/90">{props.value}</dd>
    </div>
  );
}

