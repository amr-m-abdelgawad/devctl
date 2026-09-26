import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlassIcon } from "../icons.ts";
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
  const [status, setStatus] = useState("");
  const [bodyMode, setBodyMode] = useTrafficBodyMode();
  const calls = useMemo(() => {
    const rows = payload?.calls ?? [];
    if (status === "error") {
      return rows.filter((call) => trafficIsError(call));
    }
    if (status === "ok") {
      return rows.filter((call) => !trafficIsError(call));
    }
    return rows;
  }, [payload, status]);
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
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) {
        return;
      }
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      const index = Math.max(0, calls.findIndex((call) => call.id === selectedId));
      const next = calls[Math.min(calls.length - 1, Math.max(0, index + delta))];
      if (next) {
        setInspectHash("traffic", next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calls, selectedId]);

  return (
    <div className="grid min-h-[36rem] flex-1 grid-cols-1 gap-4 lg:h-[calc(100dvh-7.5rem)] lg:min-h-0 lg:grid-cols-[minmax(20rem,34%)_minmax(0,1fr)]">
      <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Traffic</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="muted">{calls.length}</Badge>
            <CallerFilter caller={caller} callers={callers} onCaller={onCaller} />
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[12rem] flex-1">
              <span className="sr-only">Search hops</span>
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1.5 size-3.5 text-muted-foreground" />
              <input
                type="search"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder="Search hops (! excludes)"
                className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              status
              <select
                value={status}
                onChange={(event) => setStatus(event.currentTarget.value)}
                className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                <option value="">all</option>
                <option value="ok">ok</option>
                <option value="error">error</option>
              </select>
            </label>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="min-h-0 flex-1 overflow-auto">
            <TrafficList calls={calls} caller={caller} search={search} selectedId={selectedId} />
          </div>
        </CardContent>
      </Card>
      <Card className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <CardHeader className="space-y-0">
          <CardTitle>{inspectorCall ? `${inspectorCall.method} ${inspectorCall.path}` : "Inspector"}</CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden pt-0">
          <TrafficInspector call={inspectorCall} loading={loadingDetail} bodyMode={bodyMode} onBodyMode={setBodyMode} />
        </CardContent>
      </Card>
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
    return (
      <Empty>
        Set inspect.enabled on a proxy route. Direct sockets that never hit the proxy are not captured.
      </Empty>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Caller</TableHead>
          <TableHead>Route</TableHead>
          <TableHead className="text-right">Lat</TableHead>
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
                trafficIsError(call) && !selected ? "bg-destructive/[0.06]" : undefined,
              )}
              onClick={() => {
                setInspectHash("traffic", call.id);
              }}
            >
              <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                <a href={hrefFor("traffic", call.id)} className="hover:underline" onClick={(event) => event.stopPropagation()}>
                  {clockMs(call.timestamp)}
                </a>
              </TableCell>
              <TableCell className="font-mono text-xs">{trafficStatusLabel(call)}</TableCell>
              <TableCell className="max-w-[8rem] truncate font-mono text-xs">{call.caller || "—"}</TableCell>
              <TableCell className="max-w-[10rem] truncate font-mono text-xs" title={`${call.method} ${call.path}`}>
                {call.route}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)}</TableCell>
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
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      caller
      <select
        value={caller}
        onChange={(event) => onCaller(event.currentTarget.value)}
        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
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
