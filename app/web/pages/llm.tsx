import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlassIcon } from "../icons.ts";
import { clockMs, durationMs } from "../format.ts";
import { hrefFor, activeInspectId, setInspectHash } from "../hash.ts";
import { llmSourceValue } from "../llm.ts";
import { cn } from "../lib/utils.ts";
import { LlmInspector, useLlmBodyMode } from "../components/llm-inspector.tsx";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { LlmCallRow, LlmCallsPayload } from "../types.ts";

const CALLER_NONE = "-";
const SEARCH_DEBOUNCE_MS = 300;

export function LlmPage(props: {
  payload?: LlmCallsPayload;
  detail?: LlmCallRow;
  llmId?: string;
  error: string;
  caller: string;
  callers: string[];
  search: string;
  onCaller: (value: string) => void;
  onSearch: (value: string) => void;
}) {
  const { payload, detail, llmId, error, caller, callers, search, onCaller, onSearch } = props;
  const [draft, setDraft] = useState(search);
  const [status, setStatus] = useState("");
  const [bodyMode, setBodyMode] = useLlmBodyMode();
  const calls = useMemo(() => {
    const rows = payload?.calls ?? [];
    return status === "" ? rows : rows.filter((call) => call.status === status);
  }, [payload, status]);
  const errors = payload?.errors ?? [];
  const selectedId = activeInspectId(llmId, calls[0]?.id);
  const inspectorCall = detail?.id === selectedId ? detail : undefined;
  const loadingDetail = Boolean(selectedId) && detail?.id !== selectedId;

  useEffect(() => {
    setDraft(search);
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = draft.trim();
      if (next !== search) {
        onSearch(next);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, onSearch, search]);

  useEffect(() => {
    if (llmId || !calls[0]) {
      return;
    }
    setInspectHash("llm", calls[0].id);
  }, [llmId, calls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) {
        return;
      }
      const delta = keyDelta(event.key);
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      const index = Math.max(0, calls.findIndex((call) => call.id === selectedId));
      const next = calls[Math.min(calls.length - 1, Math.max(0, index + delta))];
      if (next) {
        setInspectHash("llm", next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calls, selectedId]);

  return (
    <div className="grid min-h-[36rem] flex-1 grid-cols-1 gap-4 lg:h-[calc(100dvh-7.5rem)] lg:min-h-0 lg:grid-cols-[minmax(20rem,34%)_minmax(0,1fr)]">
      <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <CardHeader className="flex-col items-start gap-2">
          <div className="flex w-full flex-wrap items-center gap-2">
            <CardTitle>LLM calls</CardTitle>
            {calls.length > 0 ? <Badge variant="muted">{calls.length}{payload?.has_more ? "+" : ""}</Badge> : null}
            <CallerFilter caller={caller} callers={callers} onCaller={onCaller} />
          </div>
          <p className="text-[11px] text-muted-foreground">LiteLLM spend logs and proxy-capture sources. j/k moves the list.</p>
          <div className="flex w-full flex-wrap items-center gap-2">
            <label className="relative min-w-[10rem] flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1.5 size-3.5 text-muted-foreground" />
              <input
                type="search"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder="Search prompts, models, callers"
                className="h-7 w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <StatusFilter value={status} onChange={setStatus} />
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-auto pt-0">
          {error ? <div className="mb-2 text-sm text-destructive">{error}</div> : null}
          {errors.map((item) => (
            <p key={item.source} className="mb-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
              {item.source}: {item.message}
            </p>
          ))}
          <LlmList calls={calls} caller={caller} search={search} selectedId={selectedId} />
        </CardContent>
      </Card>
      <Card className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <CardHeader>
          <CardTitle>{inspectorCall?.model || "Call"}</CardTitle>
          {inspectorCall ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={inspectorCall.id}>{inspectorCall.id}</span>
          ) : null}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden pt-0">
          <LlmInspector call={inspectorCall} loading={loadingDetail} bodyMode={bodyMode} onBodyMode={setBodyMode} />
        </CardContent>
      </Card>
    </div>
  );
}

function LlmList(props: { calls: LlmCallRow[]; caller: string; search: string; selectedId?: string }) {
  const { calls, caller, search, selectedId } = props;
  if (calls.length === 0) {
    if (search !== "") {
      return <Empty>No calls match “{search}”.</Empty>;
    }
    if (caller === CALLER_NONE) {
      return <Empty>No calls without a caller.</Empty>;
    }
    if (caller !== "") {
      return <Empty>No calls from caller “{caller}”.</Empty>;
    }
    return <Empty>No LLM calls yet. Enable llm.sources (type: litellm or proxy) in .devctl/config.yaml.</Empty>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden sm:table-cell">Caller</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Latency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => {
          const selected = call.id === selectedId;
          return (
            <TableRow
              key={call.id}
              aria-selected={selected}
              className={cn(
                "cursor-pointer",
                selected ? "bg-primary/10 hover:bg-primary/15" : undefined,
                call.status === "error" && !selected ? "bg-destructive/[0.06]" : undefined,
              )}
              onClick={() => {
                setInspectHash("llm", call.id);
              }}
            >
              <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{clockMs(call.timestamp)}</TableCell>
              <TableCell>
                <Badge variant={call.status === "error" ? "destructive" : "muted"}>{call.status}</Badge>
              </TableCell>
              <TableCell className="hidden max-w-[7rem] truncate text-muted-foreground sm:table-cell" title={call.caller || undefined}>
                {call.caller || "—"}
              </TableCell>
              <TableCell className="max-w-[10rem]">
                <a href={hrefFor("llm", call.id)} className="truncate font-medium text-foreground hover:underline" title={call.model}>{call.model}</a>
                <div className="truncate text-[10px] text-muted-foreground" title={llmSourceValue(call)}>{llmSourceValue(call)}</div>
              </TableCell>
              <TableCell className="text-right font-mono text-[11px]">{call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CallerFilter(props: { caller: string; callers: string[]; onCaller: (value: string) => void }) {
  const { caller, callers, onCaller } = props;
  return (
    <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
      caller
      <select
        value={caller}
        onChange={(event) => onCaller(event.currentTarget.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">All callers</option>
        {callers.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
        <option value={CALLER_NONE}>No caller</option>
      </select>
    </label>
  );
}

function StatusFilter(props: { value: string; onChange: (value: string) => void }) {
  const options = [
    { id: "", label: "all" },
    { id: "ok", label: "ok" },
    { id: "error", label: "error" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5">
      {options.map((option) => (
        <button
          key={option.id || "all"}
          type="button"
          onClick={() => props.onChange(option.id)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
            props.value === option.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function keyDelta(key: string): number {
  if (key === "j" || key === "ArrowDown") {
    return 1;
  }
  if (key === "k" || key === "ArrowUp") {
    return -1;
  }
  return 0;
}
