import { useState, type ReactNode } from "react";
import { serviceColor } from "../palette.ts";
import { JsonViewer } from "../components/json-viewer.tsx";
import { logRowKey, LogTable } from "../components/tables.tsx";
import { StatusDot } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";
import type { LogsPayload } from "../types.ts";

type Kind = "service" | "level";

function FilterGroup(props: { label: string; kind: Kind; active: string; options: string[]; onPick: (value: string) => void }) {
  const { label, kind, active, options, onPick } = props;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-12 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <Chip active={active === ""} onClick={() => onPick("")}>all</Chip>
      {options.map((name) => (
        <Chip key={name} active={active === name} onClick={() => onPick(name)}>
          {kind === "service" ? <span className="size-1.5 rounded-full" style={{ backgroundColor: serviceColor(name) }} /> : <StatusDot value={name} className="size-1.5" />}
          {name}
        </Chip>
      ))}
    </div>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        props.active
          ? "border-border bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

export function LogsPage(props: {
  logs?: LogsPayload;
  logTotal?: number;
  serviceChips: string[];
  levelChips: string[];
  filter: { service: string; level: string };
  onFilter: (next: { service: string; level: string }) => void;
}) {
  const { logs, logTotal, serviceChips, levelChips, filter, onFilter } = props;
  const [selected, setSelected] = useState("");
  const events = (logs?.events ?? []).filter((row) => {
    if (filter.service && row.service !== filter.service) {
      return false;
    }
    if (filter.level && (row.level || row.severityText) !== filter.level) {
      return false;
    }
    return true;
  });
  const selectedEvent = events.find((row, index) => logRowKey(row, index) === selected);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <Badge variant="muted">
          {logTotal && logTotal > events.length
            ? `${events.length} of ${logTotal.toLocaleString("en-US")}`
            : events.length}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 pt-0">
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5">
          <FilterGroup label="service" kind="service" active={filter.service} options={serviceChips} onPick={(value) => onFilter({ ...filter, service: value })} />
          <FilterGroup label="level" kind="level" active={filter.level} options={levelChips} onPick={(value) => onFilter({ ...filter, level: value })} />
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <LogTable events={events} selected={selected} onSelect={setSelected} />
          {selectedEvent ? (
            <JsonViewer title="Log record" input={selectedEvent} resetKey={typeof selectedEvent.seq === "number" ? `seq:${selectedEvent.seq}` : selectedEvent.timestamp} />
          ) : (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">Select a log row to inspect its JSON.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
