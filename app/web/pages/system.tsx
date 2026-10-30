import { useEffect, useState } from "react";
import { fetchBootstrapLogs, fetchUpdate } from "../api.ts";
import { relative } from "../format.ts";
import { CpuIcon, GaugeIcon, MemoryIcon, ScrollIcon, StackIcon, TimerIcon } from "../icons.ts";
import { hrefFor } from "../hash.ts";
import { useOperatorAction } from "../operator.ts";
import type { ServiceRow, StatusSummary, TaskResult, UpdateCheckPayload } from "../types.ts";
import { ChoiceGroup, SearchInput } from "../components/filters.tsx";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { Kpi, Empty } from "../components/primitives.tsx";
import { StatusBadge } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";

function bytes(value?: number): string {
  return value === undefined ? "—" : `${(value / 1_048_576).toFixed(1)} MiB`;
}
export function SystemPage(props: { status?: StatusSummary; services: ServiceRow[] }) {
  const [tab, setTab] = useState("resources");
  const [search, setSearch] = useState("");
  const [logs, setLogs] = useState("");
  const [loadError, setLoadError] = useState("");
  const [update, setUpdate] = useState<UpdateCheckPayload>();
  const [updateResult, setUpdateResult] = useState<Omit<TaskResult, "task">>();
  const [closed, setClosed] = useState(false);
  const { run, pending, error } = useOperatorAction();
  const loadLogs = async (): Promise<void> => {
    try {
      setLogs((await fetchBootstrapLogs()).text);
      setLoadError("");
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "Unable to read supervisor logs");
    }
  };
  useEffect(() => {
    if (tab === "logs") void loadLogs();
    if (tab === "maintenance")
      void fetchUpdate()
        .then(setUpdate)
        .catch(() => {});
  }, [tab]);
  const status = props.status;
  const system = status?.system;
  const lastCpu = status?.stats_series?.cpu.at(-1);
  const lastMem = status?.stats_series?.mem.at(-1);
  const rows = props.services.filter((row) => row.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="flex flex-col gap-5">
      <div className="max-w-full overflow-x-auto">
        <ChoiceGroup
          label="Supervisor view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "resources", label: "Resources" },
            { value: "logs", label: "Bootstrap logs" },
            { value: "maintenance", label: "Maintenance" },
          ]}
        />
      </div>
      {tab === "resources" ? (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Kpi
              label="Host CPU"
              icon={<CpuIcon className="size-4" />}
              value={lastCpu === undefined ? "—" : (lastCpu * 100).toFixed(1)}
              unit="%"
              sub={`${system?.cpuCount ?? "—"} logical CPUs`}
            />
            <Kpi
              label="Host memory"
              icon={<MemoryIcon className="size-4" />}
              value={lastMem === undefined ? "—" : (lastMem * 100).toFixed(1)}
              unit="%"
              sub={system ? `${(system.memAvailableKB / 1_048_576).toFixed(1)} GiB available` : undefined}
            />
            <Kpi
              label="Supervisor RSS"
              icon={<GaugeIcon className="size-4" />}
              value={bytes(status?.daemon?.rssBytes)}
              sub={`Heap ${bytes(status?.daemon?.heapBytes)}`}
            />
            <Kpi
              label="Event loop lag"
              icon={<TimerIcon className="size-4" />}
              value={status?.daemon?.eventLoopLagMs?.toFixed(0) ?? "—"}
              unit="ms"
              sub={system ? `Host uptime ${Math.floor(system.hostUptimeSec / 3600)}h` : undefined}
            />
          </div>
          <Card>
            <CardHeader>
              <div className="flex min-w-0 items-center gap-2">
                <StackIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <CardTitle>Service resources</CardTitle>
              </div>
              <SearchInput
                label="Search service resources"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                className="w-full sm:w-72"
              />
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>CPU</TableHead>
                    <TableHead>Memory</TableHead>
                    <TableHead>Restarts</TableHead>
                    <TableHead>Uptime</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.name}>
                      <TableCell>
                        <a href={hrefFor("services", row.name)} className="text-primary hover:underline">
                          {row.name}
                        </a>
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={row.state} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.cpuPercent === undefined ? "—" : `${row.cpuPercent.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.memoryKB === undefined ? "—" : bytes(row.memoryKB * 1024)}</TableCell>
                      <TableCell>{row.restarts ?? 0}</TableCell>
                      <TableCell>{row.startTime ? relative(row.startTime) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {status?.daemon?.logs ? (
            <Card>
              <CardHeader>
                <div className="flex min-w-0 items-center gap-2">
                  <ScrollIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <CardTitle>Log pipeline</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <dl className="service-facts">
                  <div>
                    <dt>Ring memory</dt>
                    <dd>{bytes(status.daemon.logs.ringBytes)}</dd>
                  </div>
                  <div>
                    <dt>Queued / spooled</dt>
                    <dd>
                      {bytes(status.daemon.logs.inFlightBytes)} / {bytes(status.daemon.logs.spooledBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>Ingest</dt>
                    <dd>
                      {status.daemon.logs.paused ? "Paused" : "Active"} · {status.daemon.logs.loss} records lost
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : tab === "logs" ? (
        <Card>
          <CardHeader>
            <CardTitle>Supervisor bootstrap logs</CardTitle>
            <Button size="sm" variant="outline" onClick={() => void loadLogs()}>
              Refresh
            </Button>
          </CardHeader>
          <CardContent>
            {loadError ? (
              <p role="alert" className="text-xs text-destructive">
                {loadError}
              </p>
            ) : logs ? (
              <div className="task-output">
                <pre>{logs}</pre>
              </div>
            ) : (
              <Empty>No bootstrap log output.</Empty>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Updates</CardTitle>
              <Button size="sm" variant="outline" onClick={() => void fetchUpdate().then(setUpdate)}>
                Check again
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm">
                {update?.newer
                  ? `${update.current} → ${update.latest}`
                  : update?.current
                    ? `Installed: ${update.current}`
                    : "Checking for updates…"}
              </p>
              <p className="text-xs text-muted-foreground">{update?.hint}</p>
              {update?.newer && update.command?.length ? (
                <ConfirmAction
                  label="Install update"
                  title={`Install devctl ${update.latest}?`}
                  description="Use the detected installation method to update devctl. Restart the supervisor afterward to run the new version."
                  disabled={Boolean(pending)}
                  onConfirm={async () => {
                    const next = await run<TaskResult>("update_apply", { confirm: true });
                    if (next) setUpdateResult(next);
                  }}
                />
              ) : null}
              {updateResult ? (
                <div className="task-output">
                  <pre>
                    Exit {updateResult.code}
                    {"\n"}
                    {updateResult.stdout}
                    {updateResult.stderr}
                  </pre>
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Session controls</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">Stopping the supervisor disconnects this console, MCP, and the proxy.</p>
              <div className="flex flex-wrap gap-2">
                <ConfirmAction
                  label="Keep services & stop supervisor"
                  title="Stop the supervisor and keep services?"
                  description="Processes stay running and can be adopted by your next devctl session. This console will disconnect."
                  disabled={Boolean(pending) || closed}
                  onConfirm={async () => {
                    const next = await run("session_shutdown", { stop_services: false, confirm: true });
                    if (next) setClosed(true);
                  }}
                />
                <ConfirmAction
                  label="Stop services & supervisor"
                  title="Shut down this workspace?"
                  description="Stop all managed services, the supervisor, proxy, MCP, and web console."
                  disabled={Boolean(pending) || closed}
                  destructive
                  onConfirm={async () => {
                    const next = await run("session_shutdown", { stop_services: true, confirm: true });
                    if (next) setClosed(true);
                  }}
                />
              </div>
              {closed ? (
                <p role="status" className="text-xs text-success">
                  Shutdown requested. Start devctl again to reconnect.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
