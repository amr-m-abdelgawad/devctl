import { PlanButton } from "./plan-button.tsx";
import { useMemo, useState } from "react";
import { envNeedsRestart, isLiveState, type RunControl } from "../control.ts";
import { fleetRows, httpPortUrl, needsAttention, toggleVisibleSelection, type FleetState } from "../fleet.ts";
import { hrefFor } from "../hash.ts";
import { useCascadeRestart } from "../hooks/use-cascade-restart.tsx";
import { useStopServices } from "../hooks/use-stop-services.tsx";
import { ArrowUpRightIcon, ArrowsClockwiseIcon, CaretLeftIcon, CaretRightIcon, PlayIcon, StopIcon, XIcon } from "../icons.ts";
import { cn } from "../lib/utils.ts";
import { serviceColor } from "../palette.ts";
import type { ConfigService, ProfileRow, ServiceRow } from "../types.ts";
import { ActionButtons, EnvSelect } from "./controls.tsx";
import { ChoiceGroup, FilterSelect, SearchInput } from "./filters.tsx";
import { Empty } from "./primitives.tsx";
import { StatusBadge } from "./status.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

function OpenHttpPort(props: { service: string; url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" asChild>
          <a href={props.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${props.service} HTTP port in a new tab`}>
            <ArrowUpRightIcon />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Open {props.url}</TooltipContent>
    </Tooltip>
  );
}

export function ServiceFleet(props: {
  services: ServiceRow[];
  config: ConfigService[];
  profiles: ProfileRow[];
  busy: boolean;
  onControl: RunControl;
}) {
  const { services, config, profiles, busy, onControl } = props;
  const [search, setSearch] = useState("");
  const [state, setState] = useState<FleetState>("all");
  const [profile, setProfile] = useState("");
  const [sort, setSort] = useState("attention");
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState("20");
  const { requestRestart, banner } = useCascadeRestart(config, onControl, busy);
  const { requestStop, confirmation } = useStopServices(config, onControl, busy);
  const filtered = useMemo(
    () => fleetRows(services, config, profiles, { search, state, profile, sort }),
    [services, config, profiles, search, state, profile, sort],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / Number(pageSize)));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * Number(pageSize), (currentPage + 1) * Number(pageSize));
  const selectedNames = selected.filter((name) => services.some((row) => row.name === name));
  const selectedSet = new Set(selectedNames);
  const allSelected = visible.length > 0 && visible.every((row) => selectedSet.has(row.name));
  const hidden = selectedNames.filter((name) => !visible.some((row) => row.name === name)).length;
  const live = services.filter((row) => isLiveState(row.state)).length;
  const definitions = new Map(config.map((row) => [row.name, row]));
  const reset = (): void => {
    setSearch("");
    setState("all");
    setProfile("");
    setPage(0);
  };
  const change = (fn: () => void): void => {
    fn();
    setPage(0);
  };
  return (
    <Card className="fleet-card">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <CardTitle>Service fleet</CardTitle>
          <Badge variant="muted">{services.length}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          {live} running · {services.filter(needsAttention).length} need attention
        </span>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="fleet-toolbar">
          <SearchInput
            label="Search services, descriptions, ports…"
            value={search}
            onChange={(event) => change(() => setSearch(event.currentTarget.value))}
            className="flex-1"
          />
          <FilterSelect
            label="Filter services by profile"
            value={profile}
            onChange={(value) => change(() => setProfile(value))}
            options={[{ value: "", label: "All profiles" }, ...profiles.map((row) => ({ value: row.name, label: row.name }))]}
          />
          <FilterSelect
            label="Sort services"
            value={sort}
            onChange={(value) => change(() => setSort(value))}
            options={[
              { value: "attention", label: "Attention first" },
              { value: "name", label: "Name A–Z" },
              { value: "state", label: "Service state" },
            ]}
          />
        </div>
        <div className="fleet-scopes">
          <div className="overflow-x-auto">
            <ChoiceGroup
              label="Service state"
              value={state}
              onChange={(value) => change(() => setState(value as FleetState))}
              options={[
                { value: "all", label: `All ${services.length}` },
                { value: "running", label: `Running ${live}` },
                { value: "attention", label: `Attention ${services.filter(needsAttention).length}` },
                { value: "stopped", label: "Stopped" },
              ]}
            />
          </div>
          {search || state !== "all" || profile ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              <XIcon data-icon="inline-start" />
              Clear filters
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">Select services for bulk actions</span>
          )}
        </div>
        {selectedNames.length ? (
          <div className="selection-bar">
            <span className="flex-1 text-xs">
              <strong>{selectedNames.length} selected</strong>
              {hidden ? <span className="text-muted-foreground"> · {hidden} outside this page</span> : null}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onControl("start_services", { services: selectedNames }, "Starting selected…")}
            >
              <PlayIcon data-icon="inline-start" />
              Start
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => requestRestart(selectedNames)}>
              <ArrowsClockwiseIcon data-icon="inline-start" />
              Restart
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => requestStop(selectedNames)}>
              <StopIcon data-icon="inline-start" />
              Stop
            </Button>
            <IconButton size="icon" variant="ghost" label="Clear selection" onClick={() => setSelected([])}>
              <XIcon />
            </IconButton>
          </div>
        ) : null}
        {banner}
        {confirmation}
        {filtered.length === 0 ? (
          <Empty>
            {services.length === 0 ? (
              "No services configured."
            ) : (
              <span>
                No services match your filters. <PlanButton services={selectedNames} busy={busy} onControl={onControl} />
                <Button size="sm" variant="link" onClick={reset}>
                  Clear filters
                </Button>
              </span>
            )}
          </Empty>
        ) : (
          <div className="fleet-list" role="table" aria-label="Services">
            <div className="fleet-row fleet-column-headings" role="row">
              <label className="fleet-select" role="columnheader">
                <input
                  type="checkbox"
                  className="fleet-checkbox"
                  aria-label="Select this page of services"
                  checked={allSelected}
                  ref={(node) => {
                    if (node) node.indeterminate = !allSelected && visible.some((row) => selectedSet.has(row.name));
                  }}
                  onChange={() =>
                    setSelected(
                      toggleVisibleSelection(
                        selectedNames,
                        visible.map((row) => row.name),
                      ),
                    )
                  }
                />
              </label>
              <span role="columnheader">Service</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="fleet-env">
                Environment
              </span>
              <span role="columnheader" className="fleet-ports">
                Ports
              </span>
              <span role="columnheader" className="text-right">
                Actions
              </span>
            </div>
            {visible.map((row) => {
              const httpUrl = httpPortUrl(row.ports);
              return (
              <div
                key={row.name}
                role="row"
                aria-selected={selectedSet.has(row.name)}
                className={cn("fleet-row fleet-service", selectedSet.has(row.name) && "fleet-selected")}
              >
                <label role="cell" className="fleet-select">
                  <input
                    type="checkbox"
                    className="fleet-checkbox"
                    aria-label={`Select ${row.name}`}
                    checked={selectedSet.has(row.name)}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(row.name) ? current.filter((name) => name !== row.name) : [...current, row.name],
                      )
                    }
                  />
                </label>
                <div role="cell" className="fleet-name">
                  <a href={hrefFor("services", row.name)} className="service-name">
                    <span className="size-2 shrink-0 rounded-sm" style={{ background: serviceColor(row.name) }} />
                    <span className="truncate">{row.name}</span>
                    <CaretRightIcon className="size-3 shrink-0 text-muted-foreground" />
                  </a>
                  <p
                    className="truncate text-[11px] text-muted-foreground"
                    title={row.last_error || definitions.get(row.name)?.description}
                  >
                    {row.last_error || definitions.get(row.name)?.description || (row.pid ? `PID ${row.pid}` : "Ready to start")}
                  </p>
                  <span className="fleet-mobile-ports font-mono text-[10px] text-muted-foreground">
                    {Object.entries(row.ports).map(([name, port], index) => (
                      <span key={name} className="inline-flex items-center gap-1">
                        {index > 0 ? <span aria-hidden="true">·</span> : null}
                        {name}:{port}
                        {name.toLowerCase() === "http" && httpUrl ? <OpenHttpPort service={row.name} url={httpUrl} /> : null}
                      </span>
                    ))}
                  </span>
                </div>
                <div role="cell" className="fleet-status flex flex-col items-start gap-1">
                  <StatusBadge value={row.state} />
                  {needsAttention(row) && row.health.toUpperCase() === "UNHEALTHY" ? (
                    <span className="text-[10px] text-warning">Health check failed</span>
                  ) : row.start_period_remaining_ms !== undefined ? (
                    <span className="text-[10px] text-muted-foreground">{Math.ceil(row.start_period_remaining_ms / 1000)}s warming up</span>
                  ) : envNeedsRestart(row) ? (
                    <span className="text-[10px] text-warning">Restart pending</span>
                  ) : null}
                </div>
                <div role="cell" className="fleet-env">
                  <EnvSelect row={row} busy={busy} onControl={onControl} onRestart={(name) => requestRestart([name])} />
                </div>
                <div
                  role="cell"
                  className="fleet-ports min-w-0 font-mono text-[11px] text-muted-foreground"
                  title={Object.entries(row.ports)
                    .map(([name, port]) => `${name}:${port}`)
                    .join(", ")}
                >
                  {Object.entries(row.ports).map(([name, port]) => {
                    const url = name.toLowerCase() === "http" ? httpUrl : undefined;
                    return (
                      <div key={name} className="flex items-center gap-1">
                        <span className="truncate">
                          {name}
                          <span className="text-foreground"> :{port}</span>
                        </span>
                        {url ? <OpenHttpPort service={row.name} url={url} /> : null}
                      </div>
                    );
                  })}
                </div>
                <div role="cell" className="fleet-actions">
                  <ActionButtons
                    live={isLiveState(row.state)}
                    busy={busy}
                    name={row.name}
                    onStart={() => onControl("start_services", { services: [row.name] }, `Starting ${row.name}…`)}
                    onStop={() => requestStop([row.name])}
                    onRestart={() => requestRestart([row.name])}
                  />
                </div>
              </div>
              );
            })}
          </div>
        )}
        <div className="fleet-pagination">
          <span className="text-xs text-muted-foreground">
            {filtered.length ? currentPage * Number(pageSize) + 1 : 0}–{Math.min((currentPage + 1) * Number(pageSize), filtered.length)} of{" "}
            {filtered.length} services{filtered.length !== services.length ? ` (${services.length} total)` : ""}
          </span>
          <div className="flex items-center gap-2">
            <FilterSelect
              label="Services per page"
              value={pageSize}
              onChange={(value) => change(() => setPageSize(value))}
              options={[20, 50, 100].map((n) => ({ value: String(n), label: `${n} / page` }))}
            />
            <IconButton
              size="icon"
              variant="outline"
              disabled={currentPage === 0}
              label="Previous services page"
              onClick={() => setPage(currentPage - 1)}
            >
              <CaretLeftIcon />
            </IconButton>
            <span className="text-xs tabular-nums text-muted-foreground">
              {currentPage + 1}/{pages}
            </span>
            <IconButton
              size="icon"
              variant="outline"
              disabled={currentPage + 1 >= pages}
              label="Next services page"
              onClick={() => setPage(currentPage + 1)}
            >
              <CaretRightIcon />
            </IconButton>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
