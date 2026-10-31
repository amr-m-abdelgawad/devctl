import { useEffect, useState } from "react";
import { InspectorFilters, type FeedControls } from "../components/filters.tsx";
import { Button } from "../components/ui/button.tsx";
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
  filters: Record<string, string>;
  onFilters: (value: Record<string, string>) => void;
  feed: FeedControls;
  models: string[];
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
  const [bodyMode, setBodyMode] = useLlmBodyMode();
  const calls = payload?.calls ?? [];
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
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) {
        return;
      }
      const delta = keyDelta(event.key);
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      const index = Math.max(
        0,
        calls.findIndex((call) => call.id === selectedId),
      );
      const next = calls[Math.min(calls.length - 1, Math.max(0, index + delta))];
      if (next) {
        setInspectHash("llm", next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calls, selectedId]);

  return (
    <div className="inspector-workspace">
      <InspectorFilters
        search={draft}
        onSearch={setDraft}
        placeholder="Search prompts, models, callers"
        caller={caller}
        callers={callers}
        onCaller={onCaller}
        filters={props.filters}
        onFilters={props.onFilters}
        fields={[{ key: "model", label: "All models", values: props.models }]}
        feed={props.feed}
      />
      <div className="inspector-panes">
        <Card className="inspector-list-card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <CardHeader>
            <CardTitle>Recent calls</CardTitle>
            <Badge variant="muted">
              {calls.length}
              {payload?.has_more ? "+" : ""}
            </Badge>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto pt-0">
            {error ? <div className="mb-2 text-sm text-destructive">{error}</div> : null}
            {errors.map((item) => (
              <p key={item.source} className="mb-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                {item.source}: {item.message}
              </p>
            ))}
            {!payload && !error ? (
              <Empty>Loading calls…</Empty>
            ) : (
              <LlmList calls={calls} caller={caller} search={search} selectedId={selectedId} />
            )}
            {payload?.has_more ? (
              <Button size="sm" variant="outline" className="mt-3 w-full" disabled={props.feed.loadingMore} onClick={props.feed.loadMore}>
                {props.feed.loadingMore ? "Loading…" : "Load older calls"}
              </Button>
            ) : null}
          </CardContent>
        </Card>
        <Card className="inspector-detail-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CardHeader>
            <CardTitle>{inspectorCall?.model || "Call"}</CardTitle>
            {inspectorCall ? (
              <span className="truncate font-mono text-[12px] text-muted-foreground" title={inspectorCall.id}>
                {inspectorCall.id}
              </span>
            ) : null}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden pt-0">
            {payload && selectedId && !calls.some((call) => call.id === selectedId) ? (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span>Pinned call is outside the current results.</span>
                {calls[0] ? (
                  <Button size="sm" variant="link" onClick={() => setInspectHash("llm", calls[0]!.id)}>
                    Inspect first result
                  </Button>
                ) : null}
              </div>
            ) : null}

            <LlmInspector call={inspectorCall} loading={loadingDetail} bodyMode={bodyMode} onBodyMode={setBodyMode} />
          </CardContent>
        </Card>
      </div>
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
    <Table className="table-fixed sm:table-auto">
      <TableHeader>
        <TableRow>
          <TableHead className="hidden sm:table-cell">Time</TableHead>
          <TableHead className="w-16 sm:w-auto">Status</TableHead>
          <TableHead className="hidden sm:table-cell">Caller</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="w-16 text-right sm:w-auto">Latency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => {
          const selected = call.id === selectedId;
          return (
            <TableRow
              key={call.id}
              aria-selected={selected}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setInspectHash("llm", call.id);
                }
              }}
              className={cn(
                "cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                selected ? "bg-primary/10 hover:bg-primary/15" : undefined,
                call.status === "error" && !selected ? "bg-destructive/[0.06]" : undefined,
              )}
              onClick={() => {
                setInspectHash("llm", call.id);
              }}
            >
              <TableCell className="hidden whitespace-nowrap font-mono text-[12px] text-muted-foreground sm:table-cell">
                {clockMs(call.timestamp)}
              </TableCell>
              <TableCell>
                <Badge variant={call.status === "error" ? "destructive" : "muted"}>{call.status}</Badge>
              </TableCell>
              <TableCell className="hidden max-w-[7rem] truncate text-muted-foreground sm:table-cell" title={call.caller || undefined}>
                {call.caller || "—"}
              </TableCell>
              <TableCell className="max-w-[10rem]">
                <a href={hrefFor("llm", call.id)} className="block truncate font-medium text-foreground hover:underline" title={call.model}>
                  {call.model}
                </a>
                <div className="truncate text-[11px] text-muted-foreground" title={llmSourceValue(call)}>
                  {llmSourceValue(call)}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-[12px]">
                {call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
