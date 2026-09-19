import { clockMs, durationMs } from "../format.ts";
import { hrefFor } from "../hash.ts";
import { cn } from "../lib/utils.ts";
import { serviceColor } from "../palette.ts";
import type { LogRow, RequestRow } from "../types.ts";
import { Empty, TraceLink } from "./primitives.tsx";
import { StatusBadge } from "./status.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";

function statusClass(status: number): string {
  if (status >= 500) {
    return "text-destructive";
  }
  if (status >= 400) {
    return "text-warning";
  }
  if (status >= 300) {
    return "text-info";
  }
  return "text-success";
}

function newestFirst<T extends { timestamp: string }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

export function RequestTable(props: { requests: RequestRow[]; onJumpRequest?: (id: string) => void; traceMsById?: Record<string, number> }) {
  const { requests, onJumpRequest, traceMsById } = props;
  if (requests.length === 0) {
    return <Empty>No proxied requests yet.</Empty>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Method</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead>Trace</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newestFirst(requests).map((row) => {
          const traceMs = row.trace_duration_ms ?? (row.trace_id ? traceMsById?.[row.trace_id] : undefined);
          return (
            <TableRow key={row.request_id} className={row.status >= 500 ? "bg-destructive/[0.06]" : undefined}>
              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{clockMs(row.timestamp)}</TableCell>
              <TableCell><Badge variant="outline" className="font-mono text-[10px]">{row.method}</Badge></TableCell>
              <TableCell className="max-w-[280px] truncate font-mono text-xs" title={row.path}>
                {row.captured ? (
                  <a href={hrefFor("traffic", row.request_id)} className="hover:underline">{row.path}</a>
                ) : row.path}
              </TableCell>
              <TableCell className={`font-mono font-medium tabular-nums ${statusClass(row.status)}`}>{row.status}</TableCell>
              <TableCell className="text-right">
                {traceMs !== undefined ? (
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-mono tabular-nums text-foreground">{durationMs(traceMs)}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{durationMs(row.duration_ms)} proxy</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-mono tabular-nums text-muted-foreground">{durationMs(row.duration_ms)}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">proxy hop</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                {row.trace_id ? <TraceLink id={row.trace_id} /> : onJumpRequest ? (
                  <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onJumpRequest(row.request_id)}>open</Button>
                ) : <span className="text-muted-foreground">—</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function logRowKey(row: LogRow, index: number): string {
  if (typeof row.seq === "number") {
    return `seq:${row.seq}`;
  }
  return `row:${index}`;
}

export function LogTable(props: { events: LogRow[]; showTrace?: boolean; selected?: string; onSelect?: (key: string) => void }) {
  const { events, showTrace = true, selected, onSelect } = props;
  if (events.length === 0) {
    return <Empty>No log records.</Empty>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Service</TableHead>
          <TableHead>Level</TableHead>
          <TableHead>Message</TableHead>
          {showTrace ? <TableHead>Trace</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((row, index) => ({ row, key: logRowKey(row, index) })).reverse().map(({ row, key }) => {
          const level = row.level || row.severityText || "info";
          const isError = level.toLowerCase().includes("error") || level.toLowerCase() === "fatal";
          const selectable = Boolean(onSelect);
          return (
            <TableRow
              key={key}
              tabIndex={selectable ? 0 : undefined}
              aria-selected={selectable ? selected === key : undefined}
              className={cn(
                isError ? "bg-destructive/[0.06]" : undefined,
                selected === key ? "bg-primary/10" : selectable ? "cursor-pointer hover:bg-accent/40" : undefined,
                selectable ? "outline-none focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" : undefined,
              )}
              onClick={onSelect ? () => onSelect(key) : undefined}
              onKeyDown={onSelect ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(key);
                }
              } : undefined}
            >
              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{clockMs(row.timestamp)}</TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: serviceColor(row.service) }} />
                  <span className="max-w-[120px] truncate" title={row.service}>{row.service}</span>
                </span>
              </TableCell>
              <TableCell><StatusBadge value={level} /></TableCell>
              <TableCell className="font-mono text-xs text-foreground/90">{row.message}</TableCell>
              {showTrace ? <TableCell>{row.traceId ? <TraceLink id={row.traceId} /> : <span className="text-muted-foreground">—</span>}</TableCell> : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
