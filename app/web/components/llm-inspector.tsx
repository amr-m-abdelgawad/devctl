import { useState, type ReactNode } from "react";
import { durationMs } from "../format.ts";
import { hrefFor } from "../hash.ts";
import {
  llmCostLabel,
  llmEffectiveBodyMode,
  llmIsRawSchema,
  llmIsStream,
  llmPathOf,
  llmSourceLabel,
  llmSourceValue,
  llmTokenLabel,
  llmTokenTotal,
  llmTurns,
  llmTurnsMarkdown,
  llmVisibleAttributes,
  prettyJson,
  type LlmBodyMode,
  type LlmTurn,
} from "../llm.ts";
import { cn } from "../lib/utils.ts";
import { CopyTextButton, JsonViewer } from "./json-viewer.tsx";
import { Empty, TraceLink } from "./primitives.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import type { LlmCallRow } from "../types.ts";

const FIND_MIN = 2;
const BODY_MODE_KEY = "devctl.llm.bodyMode";

function persistBodyMode(mode: LlmBodyMode): void {
  try {
    window.localStorage.setItem(BODY_MODE_KEY, mode);
  } catch {
    return;
  }
}

function readStoredBodyMode(): LlmBodyMode {
  try {
    const stored = window.localStorage.getItem(BODY_MODE_KEY) ?? "";
    return stored === "json" ? "json" : "conversation";
  } catch {
    return "conversation";
  }
}

export function LlmInspector(props: {
  call?: LlmCallRow;
  loading: boolean;
  bodyMode: LlmBodyMode;
  onBodyMode: (mode: LlmBodyMode) => void;
}) {
  const { call, loading, bodyMode, onBodyMode } = props;
  const [find, setFind] = useState("");
  const [wrapJson, setWrapJson] = useState(true);
  if (!call) {
    return <Empty>{loading ? "Loading call…" : "Select a call to inspect the conversation or raw JSON."}</Empty>;
  }
  const turns = llmTurns(call);
  const canToggle = turns.length > 0;
  const effective = llmEffectiveBodyMode(turns, bodyMode);
  const needle = find.trim();
  const shownTurns = filterTurns(turns, needle);
  const requestJson = prettyJson(call.request);
  const responseJson = prettyJson(call.response);
  const attrs = llmVisibleAttributes(call);
  const path = llmPathOf(call);
  const traceId = call.trace_id?.trim() ?? "";
  const usage = call.usage;
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const total = llmTokenTotal(usage);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={call.status === "error" ? "destructive" : "success"}>{call.status}</Badge>
        <Badge variant="info">{call.operation}</Badge>
        {call.duration_ms === undefined ? null : <Badge variant="muted">{durationMs(call.duration_ms)}</Badge>}
        <Badge variant="muted">{llmTokenLabel(usage)} tok</Badge>
        {call.cost === undefined ? null : <Badge variant="muted">{llmCostLabel(call.cost)}</Badge>}
        {llmIsRawSchema(call) ? <Badge variant="warning">raw</Badge> : null}
        {llmIsStream(call) ? <Badge variant="outline">stream</Badge> : null}
        {call.vendor ? <Badge variant="outline">{call.vendor}</Badge> : null}
      </div>
      {call.error ? (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive">{call.error}</p>
      ) : null}
      {loading && call.request === undefined && call.response === undefined ? (
        <p className="text-[11px] text-muted-foreground">Loading payload…</p>
      ) : null}
      {total > 0 ? <TokenBar prompt={prompt} completion={completion} total={total} /> : null}
      <dl className="flex flex-col gap-1 text-xs">
        <Kv label="caller" value={call.caller || "—"} />
        <Kv label={llmSourceLabel(call)} value={llmSourceValue(call)} />
        <Kv label="model" value={modelLine(call)} />
        {path !== "" ? <Kv label="path" value={path} /> : null}
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
          <ModeTab
            label="Conversation"
            active={effective === "conversation"}
            disabled={!canToggle}
            onClick={() => onBodyMode("conversation")}
          />
          <ModeTab
            label="JSON"
            active={effective === "json"}
            onClick={() => onBodyMode("json")}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {effective === "conversation" && canToggle ? (
            <CopyTextButton text={llmTurnsMarkdown(turns)} label="Copy transcript" />
          ) : null}
          {effective === "json" ? (
            <>
              <CopyTextButton text={[requestJson, responseJson].filter((part) => part !== "").join("\n\n")} label="Copy JSON" />
              <Button type="button" size="xs" variant={wrapJson ? "secondary" : "ghost"} onClick={() => setWrapJson((value) => !value)}>
                {wrapJson ? "Unwrap" : "Wrap"}
              </Button>
            </>
          ) : null}
          <label className="min-w-[10rem] flex-1">
            <span className="sr-only">Find in payload</span>
            <input
              type="search"
              value={find}
              onChange={(event) => setFind(event.currentTarget.value)}
              placeholder={effective === "conversation" ? "Find in conversation" : "Find in JSON"}
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {effective === "conversation" ? (
          <Transcript turns={shownTurns} total={turns.length} needle={needle} />
        ) : (
          <JsonPanes request={call.request} response={call.response} wrap={wrapJson} needle={needle} />
        )}
        {attrs.length === 0 ? null : (
          <div className="mt-4">
            <JsonViewer title="Attributes" input={Object.fromEntries(attrs)} needle={needle} wrap={wrapJson} />
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTab(props: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        props.active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

function Transcript(props: { turns: LlmTurn[]; total: number; needle: string }) {
  const { turns, total, needle } = props;
  if (total === 0) {
    return <Empty>No chat-shaped messages. Switch to JSON for the raw bodies.</Empty>;
  }
  if (turns.length === 0) {
    return <Empty>No turns match “{needle}”.</Empty>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {turns.length < total ? (
        <p className="text-[11px] text-muted-foreground">{turns.length} of {total} turns</p>
      ) : null}
      {turns.map((turn, index) => (
        <article key={`${turn.role}-${index}`} className={cn("rounded-lg border border-border/60 px-3 py-2", roleSurface(turn.role))}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", roleColor(turn.role))}>{turn.role}</span>
            <CopyTextButton text={turn.content} />
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{highlight(turn.content, needle)}</p>
        </article>
      ))}
    </div>
  );
}

function JsonPanes(props: { request: unknown; response: unknown; wrap: boolean; needle: string }) {
  const { request, response, wrap, needle } = props;
  if (request === undefined && response === undefined) {
    return <Empty>No request/response body.</Empty>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {request === undefined ? null : <JsonViewer title="Request" input={request} wrap={wrap} needle={needle} />}
      {response === undefined ? null : <JsonViewer title="Response" input={response} wrap={wrap} needle={needle} />}
    </div>
  );
}

function TokenBar(props: { prompt: number; completion: number; total: number }) {
  const { prompt, completion, total } = props;
  const promptPct = Math.max(0, Math.min(100, (prompt / total) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
        <span>prompt {prompt.toLocaleString("en-US")}</span>
        <span>completion {completion.toLocaleString("en-US")}</span>
        <span>total {total.toLocaleString("en-US")}</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-primary" style={{ width: `${promptPct}%` }} />
        <div className="bg-info/80" style={{ width: `${100 - promptPct}%` }} />
      </div>
    </div>
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

function filterTurns(turns: LlmTurn[], needle: string): LlmTurn[] {
  if (needle.length < FIND_MIN) {
    return turns;
  }
  const lower = needle.toLowerCase();
  return turns.filter((turn) => turn.role.toLowerCase().includes(lower) || turn.content.toLowerCase().includes(lower));
}

function highlight(text: string, needle: string): ReactNode {
  if (needle.length < FIND_MIN) {
    return text;
  }
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match = lower.indexOf(target, cursor);
  let index = 0;
  while (match !== -1) {
    if (match > cursor) {
      parts.push(text.slice(cursor, match));
    }
    parts.push(
      <mark key={index} className="rounded-sm bg-warning/35 text-foreground">
        {text.slice(match, match + needle.length)}
      </mark>,
    );
    cursor = match + needle.length;
    index += 1;
    match = lower.indexOf(target, cursor);
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

function modelLine(call: LlmCallRow): string {
  return call.routed_model && call.routed_model !== call.model ? `${call.model} → ${call.routed_model}` : call.model;
}

function roleColor(role: string): string {
  const kind = role.toLowerCase();
  if (kind === "assistant") {
    return "text-success";
  }
  if (kind === "system" || kind === "tool") {
    return "text-info";
  }
  return "text-primary";
}

function roleSurface(role: string): string {
  const kind = role.toLowerCase();
  if (kind === "assistant") {
    return "bg-success/8";
  }
  if (kind === "system" || kind === "tool") {
    return "bg-info/8";
  }
  return "bg-primary/8";
}

export function useLlmBodyMode(): [LlmBodyMode, (mode: LlmBodyMode) => void] {
  const [mode, setMode] = useState<LlmBodyMode>(readStoredBodyMode);
  const update = (next: LlmBodyMode): void => {
    setMode(next);
    persistBodyMode(next);
  };
  return [mode, update];
}
