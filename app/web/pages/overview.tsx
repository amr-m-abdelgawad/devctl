import {
  ArrowsLeftRightIcon,
  CaretRightIcon,
  GaugeIcon,
  LightningIcon,
  PlayIcon,
  RobotIcon,
  StackIcon,
  StopIcon,
  TimerIcon,
  WarningIcon,
} from "../icons.ts";
import { useState } from "react";
import { isLiveState, type RunControl } from "../control.ts";
import { durationMs, relative } from "../format.ts";
import { useStopServices } from "../hooks/use-stop-services.tsx";
import { ServiceFleet } from "../components/service-fleet.tsx";
import { FilterSelect } from "../components/filters.tsx";
import { hrefFor } from "../hash.ts";
import { RequestTable } from "../components/tables.tsx";
import { Empty, Kpi } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ConfigService, LlmCallRow, LogRow, ProfileRow, RequestsPayload, ServiceRow, TaskRow } from "../types.ts";

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

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function OverviewPage(props: {
  summary: OverviewSummary;
  services: ServiceRow[];
  requests?: RequestsPayload;
  errors: LogRow[];
  llmCalls: LlmCallRow[];
  profiles: ProfileRow[];
  tasks: TaskRow[];
  configServices: ConfigService[];
  profile: string;
  busy: boolean;
  traceMsById?: Record<string, number>;
  onControl: RunControl;
}) {
  const { summary, services, requests, errors, llmCalls, profiles, configServices, profile, busy, traceMsById, onControl } = props;
  const [profileName, setProfileName] = useState(profile);
  const chosenProfile = profiles.some((row) => row.name === profileName)
    ? profileName
    : profiles.some((row) => row.name === profile)
      ? profile
      : profiles[0]?.name || "";
  const liveNames = services.filter((row) => isLiveState(row.state)).map((row) => row.name);
  const recentErrors = errors.slice(-8).reverse();
  const recentRequests = [...(requests?.requests ?? [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 12);
  const recentLlm = [...llmCalls].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8);
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

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:items-stretch">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-nowrap">
            <div className="flex min-w-0 items-center gap-2">
              <ArrowsLeftRightIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <CardTitle className="truncate">Recent proxy requests</CardTitle>
              {recentRequests.length > 0 ? <Badge variant="muted">{countLabel(recentRequests.length, "request")}</Badge> : null}
            </div>
            <a href={hrefFor("traces")} className="shrink-0 text-xs font-medium text-primary hover:underline">
              View all →
            </a>
          </CardHeader>
          <CardContent className="pt-0">
            <RequestTable requests={recentRequests} traceMsById={traceMsById} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4 lg:h-full">
        <Card className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
          <CardHeader className="shrink-0 flex-nowrap">
            <div className="flex min-w-0 items-center gap-2">
              <WarningIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <CardTitle className="truncate">Recent errors</CardTitle>
              {recentErrors.length > 0 ? <Badge variant="destructive">{countLabel(recentErrors.length, "error")}</Badge> : null}
            </div>
            <a href={hrefFor("logs")} className="shrink-0 text-xs font-medium text-primary hover:underline">
              View logs →
            </a>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col pt-0 pb-3">
            {recentErrors.length === 0 ? (
              <div className="flex flex-1 items-center">
                <Empty>{summary.logErrors > 0 ? "No errors in the recent log window." : "Nothing is failing right now."}</Empty>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/50 [&>*:last-child]:border-b-0">
                {recentErrors.map((row, index) => (
                  <a
                    key={`${row.seq ?? index}`}
                    href={`${hrefFor("logs")}?service=${encodeURIComponent(row.service)}`}
                    className="flex min-h-0 min-w-0 flex-1 items-center gap-2 hover:text-primary"
                    title={row.message}
                  >
                    <span className="w-24 shrink-0 truncate text-xs font-medium">{row.service}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{row.message}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relative(row.timestamp)}</span>
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
          <CardHeader className="shrink-0 flex-nowrap">
            <div className="flex min-w-0 items-center gap-2">
              <RobotIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <CardTitle className="truncate">Recent LLM calls</CardTitle>
              {recentLlm.length > 0 ? <Badge variant="muted">{countLabel(recentLlm.length, "call")}</Badge> : null}
            </div>
            <a href={hrefFor("llm")} className="shrink-0 text-xs font-medium text-primary hover:underline">
              View all →
            </a>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col pt-0 pb-3">
            {recentLlm.length === 0 ? (
              <div className="flex flex-1 items-center">
                <Empty>No LLM calls yet.</Empty>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/50 [&>*:last-child]:border-b-0">
                {recentLlm.map((call) => (
                  <a
                    key={call.id}
                    href={hrefFor("llm", call.id)}
                    className="flex min-h-0 min-w-0 flex-1 items-center gap-2 hover:text-primary"
                    title={call.model || call.id}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{call.model || call.operation || "call"}</span>
                    <span className="max-w-24 shrink-0 truncate text-[10px] text-muted-foreground">{call.caller || "—"}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {call.duration_ms === undefined ? "—" : durationMs(call.duration_ms)}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  );
}
