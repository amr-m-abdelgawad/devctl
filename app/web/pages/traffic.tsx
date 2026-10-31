import { useEffect, useState } from "react";
import { InspectorFilters, type FeedControls } from "../components/filters.tsx";
import { Button } from "../components/ui/button.tsx";
import { clockMs, durationMs } from "../format.ts";
import { hrefFor, activeInspectId, setInspectHash } from "../hash.ts";
import { trafficIsError, trafficStatusLabel } from "../traffic.ts";
import { cn } from "../lib/utils.ts";
import { TrafficInspector, useTrafficBodyMode } from "../components/traffic-inspector.tsx";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { TrafficCallRow, TrafficCallsPayload } from "../types.ts";

const CALLER_NONE = "-";
const SEARCH_DEBOUNCE_MS = 300;

export function TrafficPage(props: {
  filters: Record<string, string>;
  onFilters: (value: Record<string, string>) => void;
  feed: FeedControls;
  routes: string[];
  payload?: TrafficCallsPayload;
  detail?: TrafficCallRow;
  trafficId?: string;
  error: string;
  caller: string;
  callers: string[];
  search: string;
  onCaller: (value: string) => void;
  onSearch: (value: string) => void;
}) {
  const { payload, detail, trafficId, error, caller, callers, search, onCaller, onSearch } = props;
  const [draft, setDraft] = useState(search);
  const [bodyMode, setBodyMode] = useTrafficBodyMode();
  const calls = payload?.calls ?? [];
  const selectedId = activeInspectId(trafficId, calls[0]?.id);
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
    if (trafficId || !calls[0]) {
      return;
    }
    setInspectHash("traffic", calls[0].id);
  }, [trafficId, calls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) {
        return;
      }
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
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
        setInspectHash("traffic", next.id);
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
        placeholder="Search hops (! excludes)"
        caller={caller}
        callers={callers}
        onCaller={onCaller}
        filters={props.filters}
        onFilters={props.onFilters}
        fields={[
          { key: "route", label: "All routes", values: props.routes },
          { key: "transport", label: "All protocols", values: ["http", "grpc"] },
          { key: "method", label: "All methods", values: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
        ]}
        feed={props.feed}
      />
      <div className="inspector-panes">
        <Card className="inspector-list-card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <CardHeader>
            <CardTitle>Captured requests</CardTitle>
            <Badge variant="muted">
              {calls.length}
              {payload?.has_more ? "+" : ""}
            </Badge>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-0">
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="min-h-0 flex-1 overflow-auto">
              {!payload && !error ? (
                <Empty>Loading traffic…</Empty>
              ) : (
                <TrafficList calls={calls} caller={caller} search={search} selectedId={selectedId} />
              )}
            </div>
            {payload?.has_more ? (
              <Button size="sm" variant="outline" disabled={props.feed.loadingMore} onClick={props.feed.loadMore}>
                {props.feed.loadingMore ? "Loading…" : "Load older requests"}
              </Button>
            ) : null}
          </CardContent>
        </Card>
        <Card className="inspector-detail-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CardHeader className="min-w-0">
            <CardTitle className="min-w-0 break-all">
              {inspectorCall ? `${inspectorCall.method} ${inspectorCall.path}` : "Request inspector"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden pt-0">
            {payload && selectedId && !calls.some((call) => call.id === selectedId) ? (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span>Pinned request is outside the current results.</span>
                {calls[0] ? (
                  <Button size="sm" variant="link" onClick={() => setInspectHash("traffic", calls[0]!.id)}>
                    Inspect first result
                  </Button>
                ) : null}
              </div>
            ) : null}

            <TrafficInspector call={inspectorCall} loading={loadingDetail} bodyMode={bodyMode} onBodyMode={setBodyMode} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function TrafficList(props: { calls: TrafficCallRow[]; caller: string; search: string; selectedId?: string }) {
  const { calls, caller, search, selectedId } = props;
  if (calls.length === 0) {
    if (search !== "") {
      return <Empty>No hops match “{search}”.</Empty>;
    }
    if (caller === CALLER_NONE) {
      return <Empty>No hops without a caller.</Empty>;
    }
    if (caller !== "") {
      return <Empty>No hops from caller “{caller}”.</Empty>;
    }
    return <Empty>Set inspect.enabled on a proxy route. Direct sockets that never hit the proxy are not captured.</Empty>;
  }
  return (
    <Table className="table-fixed sm:table-auto">
      <TableHeader>
        <TableRow>
          <TableHead className="hidden sm:table-cell">Time</TableHead>
          <TableHead className="w-16 sm:w-auto">Status</TableHead>
          <TableHead className="hidden sm:table-cell">Caller</TableHead>
          <TableHead>Request</TableHead>
          <TableHead className="w-16 text-right sm:w-auto">Lat</TableHead>
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
                  setInspectHash("traffic", call.id);
                }
              }}
              className={cn(
                "cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                selected ? "bg-primary/10 hover:bg-primary/15" : undefined,
                trafficIsError(call) && !selected ? "bg-destructive/[0.06]" : undefined,
              )}
              onClick={() => {
                setInspectHash("traffic", call.id);
              }}
            >
              <TableCell className="hidden whitespace-nowrap font-mono text-[12px] text-muted-foreground sm:table-cell">
                <a href={hrefFor("traffic", call.id)} className="hover:underline" onClick={(event) => event.stopPropagation()}>
                  {clockMs(call.timestamp)}
                </a>
              </TableCell>
              <TableCell>
                <Badge variant={trafficIsError(call) ? "destructive" : "muted"}>{trafficStatusLabel(call)}</Badge>
              </TableCell>
              <TableCell className="hidden max-w-[8rem] truncate font-mono text-xs sm:table-cell">{call.caller || "—"}</TableCell>
              <TableCell className="max-w-[10rem] truncate font-mono text-xs" title={`${call.method} ${call.path}`}>
                <a href={hrefFor("traffic", call.id)} className="block truncate hover:text-primary">
                  {call.method} {call.path}
                </a>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {call.route}
                  {call.caller ? ` · ${call.caller}` : ""}
                </span>
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
