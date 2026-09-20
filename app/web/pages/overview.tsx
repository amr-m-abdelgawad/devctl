import { GaugeIcon, LightningIcon, StackIcon, TimerIcon, WarningIcon } from "../icons.ts";
import { useMemo, useState } from "react";
import { isLiveState, type RunControl } from "../control.ts";
import { durationMs, relative } from "../format.ts";
import { useCascadeRestart } from "../hooks/use-cascade-restart.tsx";
import { serviceColor } from "../palette.ts";
import { RequestTable } from "../components/tables.tsx";
import { ActionButtons, EnvSelect, FleetBar } from "../components/controls.tsx";
import { Empty, Kpi } from "../components/primitives.tsx";
import { StatusBadge } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { ConfigService, LogRow, ProfileRow, RequestsPayload, ServiceRow, TaskRow } from "../types.ts";

export type OverviewSummary = {
  healthy: number;
  total: number;
  requests: number;
  errors: number;
  errorRate: number;
  errPerSec: number;
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
  const { summary, services, requests, errors, profiles, tasks, configServices, profile, busy, traceMsById, onControl } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const [profileName, setProfileName] = useState(profile);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const { requestRestart, banner: restartBanner } = useCascadeRestart(configServices, onControl, busy);
  const chosenProfile = profiles.some((row) => row.name === profileName)
    ? profileName
    : (profiles.some((row) => row.name === profile) ? profile : profiles[0]?.name ?? "");
  const liveNames = useMemo(() => services.filter((row) => isLiveState(row.state)).map((row) => row.name), [services]);
  const selectedNames = useMemo(() => {
    const names = new Set(services.map((row) => row.name));
    return selected.filter((name) => names.has(name));
  }, [selected, services]);
  const selectedSet = new Set(selectedNames);
  const allSelected = services.length > 0 && selectedNames.length === services.length;
  const healthTone = summary.total === 0 ? "muted" : summary.healthy === summary.total ? "success" : summary.healthy === 0 ? "destructive" : "warning";
  const noneLive = liveNames.length === 0 && services.length > 0;

  const toggleAll = (): void => {
    setSelected(allSelected ? [] : services.map((row) => row.name));
  };
  const toggleOne = (name: string): void => {
    setSelected((cur) => (cur.includes(name) ? cur.filter((item) => item !== name) : [...cur, name]));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]">
        <Kpi label="Services" value={`${summary.healthy}/${summary.total}`} tone={healthTone} sub="healthy" icon={<StackIcon className="size-4" />} />
        <Kpi label="Requests" value={summary.requests.toLocaleString("en-US")} tone="muted" sub="since daemon start" icon={<GaugeIcon className="size-4" />} />
        <Kpi label="Errors" value={summary.errors.toLocaleString("en-US")} tone={summary.errors > 0 ? "destructive" : "muted"} sub={`${summary.errPerSec.toFixed(summary.errPerSec >= 10 ? 0 : 1)}/s · ${summary.errorRate.toFixed(1)}% of logs`} icon={<WarningIcon className="size-4" />} />
        <Kpi label="Latency p95" value={summary.p95 ? Math.round(summary.p95) : "—"} unit={summary.p95 ? "ms" : undefined} tone={summary.p95 > 500 ? "warning" : "muted"} sub="last 10s of recent requests" icon={<TimerIcon className="size-4" />} />
        <Kpi label="Throughput" value={summary.reqPerSec.toFixed(summary.reqPerSec >= 10 ? 0 : 1)} unit="req/s" tone="muted" sub="last 10s of recent requests" icon={<LightningIcon className="size-4" />} />
      </div>

      {noneLive ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Nothing is running</span>
            <span className="text-[12px] text-muted-foreground">
              Same as the TUI empty dashboard: start a profile (dependencies come along).
            </span>
          </div>
          <Button type="button" size="sm" disabled={busy || !chosenProfile} onClick={() => onControl("start_services", { profile: chosenProfile }, `Starting ${chosenProfile}…`)}>
            Start {chosenProfile || "profile"}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-wrap gap-y-2">
            <div className="flex items-center gap-3">
              <CardTitle>Services</CardTitle>
              <Badge variant="muted">{services.length}</Badge>
            </div>
            <FleetBar
              profiles={profiles}
              profile={chosenProfile}
              tasks={tasks}
              busy={busy}
              selectedCount={selectedNames.length}
              liveCount={liveNames.length}
              onProfile={setProfileName}
              onStartProfile={() => onControl("start_services", { profile: chosenProfile }, `Starting ${chosenProfile}…`)}
              onStartSelected={() => onControl("start_services", { services: selectedNames }, "Starting selected…")}
              onStopSelected={() => onControl("stop_services", { services: selectedNames }, "Stopping selected…")}
              onRestartSelected={() => requestRestart(selectedNames)}
              onStopAll={() => setConfirmStopAll(true)}
              onReload={() => onControl("reload_config", {}, "Reloading config…")}
              onRunTask={(name) => onControl("run_task", { name }, `Running ${name}…`)}
            />
          </CardHeader>
          <CardContent className="pt-0">
            {restartBanner}
            {confirmStopAll ? (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]">
                <span>Stop every running service? Dependents go down with them.</span>
                <div className="flex gap-1">
                  <Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => {
                    setConfirmStopAll(false);
                    onControl("stop_services", {}, "Stopping all…");
                  }}>Stop all</Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmStopAll(false)}>Cancel</Button>
                </div>
              </div>
            ) : null}
            {services.length === 0 ? <Empty>No services in this profile.</Empty> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all services"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Env</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>Ports</TableHead>
                    <TableHead className="text-right">Control</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map((row) => (
                    <TableRow key={row.name} className={selectedSet.has(row.name) ? "bg-accent/40" : undefined}>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-3.5 accent-primary"
                          checked={selectedSet.has(row.name)}
                          onChange={() => toggleOne(row.name)}
                          aria-label={`Select ${row.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2 font-medium">
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: serviceColor(row.name) }} />
                          {row.name}
                        </span>
                      </TableCell>
                      <TableCell><StatusBadge value={row.state} /></TableCell>
                      <TableCell>
                        <EnvSelect row={row} busy={busy} onControl={onControl} onRestart={(name) => requestRestart([name])} />
                      </TableCell>
                      <TableCell>
                        {row.start_period_remaining_ms !== undefined ? (
                          <div className="flex flex-col gap-0.5" title={row.start_period_total_ms !== undefined ? `${durationMs(row.start_period_remaining_ms)} of ${durationMs(row.start_period_total_ms)} start period remaining` : `${durationMs(row.start_period_remaining_ms)} start period remaining`}>
                            <StatusBadge value={row.health || "unknown"} />
                            <span className="text-[10px] text-muted-foreground">{durationMs(row.start_period_remaining_ms)} start left</span>
                          </div>
                        ) : (
                          <StatusBadge value={row.health || "unknown"} />
                        )}
                      </TableCell>
                      <TableCell className="font-mono tabular-nums text-muted-foreground">{row.pid || "—"}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {Object.entries(row.ports ?? {}).map(([name, port]) => `${name}:${port}`).join("  ") || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <ActionButtons
                          live={isLiveState(row.state)}
                          busy={busy}
                          onStart={() => onControl("start_services", { services: [row.name] }, `Starting ${row.name}…`)}
                          onStop={() => onControl("stop_services", { services: [row.name] }, `Stopping ${row.name}…`)}
                          onRestart={() => requestRestart([row.name])}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Profiles</CardTitle>
            <Badge variant="muted">{profiles.length}</Badge>
          </CardHeader>
          <CardContent className="pt-0">
            {profiles.length === 0 ? <Empty>No profiles.</Empty> : (
              <div className="flex flex-col divide-y divide-border/50">
                {profiles.map((row) => (
                  <div key={row.name} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{row.name}</span>
                      <Button
                        type="button"
                        size="xs"
                        variant={row.name === chosenProfile ? "default" : "outline"}
                        disabled={busy}
                        onClick={() => onControl("start_services", { profile: row.name }, `Starting ${row.name}…`)}
                      >
                        Start
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {row.services.map((svc) => (
                        <span key={svc} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          <span className="size-1.5 rounded-full" style={{ backgroundColor: serviceColor(svc) }} />
                          {svc}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Proxy requests</CardTitle>
            {requests?.requests.length ? <Badge variant="muted">{requests.requests.length} recent</Badge> : null}
          </CardHeader>
          <CardContent className="pt-0"><RequestTable requests={requests?.requests ?? []} traceMsById={traceMsById} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent errors</CardTitle>
            {summary.errors > 0 ? <Badge variant="destructive">{summary.errors.toLocaleString("en-US")}</Badge> : null}
          </CardHeader>
          <CardContent className="pt-0">
            {errors.length === 0 ? <Empty>No error-level logs.</Empty> : (
              <div className="flex flex-col divide-y divide-border/50">
                {errors.slice(-14).reverse().map((row, index) => (
                  <div key={`${row.seq ?? index}`} className="flex items-start gap-2.5 py-2 first:pt-0">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-destructive" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium text-foreground/90" title={row.service}>{row.service}</span>
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
