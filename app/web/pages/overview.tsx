import { CaretRightIcon, GaugeIcon, LightningIcon, PlayIcon, StackIcon, StopIcon, TimerIcon, WarningIcon } from "../icons.ts";
import { useState } from "react";
import { isLiveState, type RunControl } from "../control.ts";
import { relative } from "../format.ts";
import { useStopServices } from "../hooks/use-stop-services.tsx";
import { ServiceFleet } from "../components/service-fleet.tsx";
import { FilterSelect } from "../components/filters.tsx";
import { hrefFor } from "../hash.ts";
import { RequestTable } from "../components/tables.tsx";
import { Empty, Kpi } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ConfigService, LogRow, ProfileRow, RequestsPayload, ServiceRow, TaskRow } from "../types.ts";

export type OverviewSummary = {
  healthy: number;
  total: number;
  requests: number;
  failedRequests: number;
  failedRate: number;
  failedPerSec: number;
  logErrors: number;
  p95: number;
  reqPerSec: number;
};

export function OverviewPage(props: {
  summary: OverviewSummary;
  services: ServiceRow[];
  requests?: RequestsPayload;
  errors: LogRow[];
  profiles: ProfileRow[];
  tasks: TaskRow[];
  configServices: ConfigService[];
  profile: string;
  busy: boolean;
  traceMsById?: Record<string, number>;
  onControl: RunControl;
}) {
  const { summary, services, requests, errors, profiles, configServices, profile, busy, traceMsById, onControl } = props;
  const [profileName, setProfileName] = useState(profile);
  const chosenProfile = profiles.some((row) => row.name === profileName)
    ? profileName
    : profiles.some((row) => row.name === profile)
      ? profile
      : profiles[0]?.name || "";
  const liveNames = services.filter((row) => isLiveState(row.state)).map((row) => row.name);
  const { requestStop, confirmation } = useStopServices(configServices, onControl, busy);
  const healthTone =
    summary.total === 0 ? "muted" : summary.healthy === summary.total ? "success" : summary.healthy === 0 ? "muted" : "warning";
  const noneLive = liveNames.length === 0 && services.length > 0;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]">
        <Kpi
          label="Services"
          value={`${summary.healthy}/${summary.total}`}
          tone={healthTone}
          sub="healthy"
          icon={<StackIcon className="size-4" />}
        />
        <Kpi
          label="Requests"
          value={summary.requests.toLocaleString("en-US")}
          tone="muted"
          sub="since daemon start"
          icon={<GaugeIcon className="size-4" />}
        />
        <Kpi
          label="Failed requests"
          value={summary.failedRequests.toLocaleString("en-US")}
          tone={summary.failedRequests > 0 ? "destructive" : "muted"}
          sub={`${summary.failedPerSec.toFixed(summary.failedPerSec >= 10 ? 0 : 1)}/s · ${summary.failedRate.toFixed(1)}% of requests`}
          icon={<WarningIcon className="size-4" />}
        />
        <Kpi
          label="Latency p95"
          value={summary.p95 ? Math.round(summary.p95) : "—"}
          unit={summary.p95 ? "ms" : undefined}
          tone={summary.p95 > 500 ? "warning" : "muted"}
          sub="recent request buffer"
          icon={<TimerIcon className="size-4" />}
        />
        <Kpi
          label="Throughput"
          value={summary.reqPerSec.toFixed(summary.reqPerSec >= 10 ? 0 : 1)}
          unit="req/s"
          tone="muted"
          sub="last 10s of recent requests"
          icon={<LightningIcon className="size-4" />}
        />
      </div>

      <div className="workspace-actionbar">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{noneLive ? "Your workspace is ready" : "Workspace controls"}</span>
          <span className="text-xs text-muted-foreground">
            {noneLive
              ? "Choose a profile to start its services and dependencies."
              : `${liveNames.length} services running. Start a profile or manage the fleet below.`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="Profile to start"
            value={chosenProfile}
            onChange={setProfileName}
            disabled={busy || profiles.length === 0}
            options={
              profiles.length ? profiles.map((row) => ({ value: row.name, label: row.name })) : [{ value: "", label: "No profiles" }]
            }
          />
          <Button
            size="sm"
            disabled={busy || !chosenProfile}
            onClick={() => onControl("start_services", { profile: chosenProfile }, `Starting ${chosenProfile}…`)}
          >
            <PlayIcon data-icon="inline-start" />
            Start profile
          </Button>
          <Button size="sm" variant="outline" disabled={busy || liveNames.length === 0} onClick={() => requestStop([])}>
            <StopIcon data-icon="inline-start" />
            Stop all
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={hrefFor("workspace")}>
              Profiles & tasks
              <CaretRightIcon data-icon="inline-end" />
            </a>
          </Button>
        </div>
      </div>
      {confirmation}
      <ServiceFleet services={services} config={configServices} profiles={profiles} busy={busy} onControl={onControl} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent proxy requests</CardTitle>
            <a href={hrefFor("traces")} className="text-xs text-primary hover:underline">
              View all →
            </a>
            {requests?.requests.length ? <Badge variant="muted">{requests.requests.length} recent</Badge> : null}
          </CardHeader>
          <CardContent className="pt-0">
            <RequestTable
              requests={[...(requests?.requests ?? [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 12)}
              traceMsById={traceMsById}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent errors</CardTitle>
            {summary.logErrors > 0 ? <Badge variant="destructive">{summary.logErrors.toLocaleString("en-US")}</Badge> : null}
          </CardHeader>
          <CardContent className="pt-0">
            {errors.length === 0 ? (
              <Empty>No error-level logs.</Empty>
            ) : (
              <div className="flex flex-col divide-y divide-border/50">
                {errors
                  .slice(-14)
                  .reverse()
                  .map((row, index) => (
                    <div key={`${row.seq ?? index}`} className="flex items-start gap-2.5 py-2 first:pt-0">
                      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-destructive" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-foreground/90" title={row.service}>
                            {row.service}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relative(row.timestamp)}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 font-mono text-[11px] leading-snug text-muted-foreground">{row.message}</p>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
