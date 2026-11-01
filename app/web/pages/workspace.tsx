import { PlanButton } from "../components/plan-button.tsx";
import { ServiceDetail } from "../components/service-detail.tsx";
import { useState } from "react";
import { postControl } from "../api.ts";
import { serviceIsHealthy } from "../fleet.ts";
import { CaretRightIcon, PlayIcon, StackIcon, TerminalWindowIcon } from "../icons.ts";
import type { ConfigService, ProfileRow, ServiceRow, TaskResult, TaskRow } from "../types.ts";
import { ChoiceGroup, SearchInput } from "../components/filters.tsx";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { RunControl } from "../control.ts";

export function WorkspacePage(props: {
  profiles: ProfileRow[];
  tasks: TaskRow[];
  services: ServiceRow[];
  configServices: ConfigService[];
  profile: string;
  busy: boolean;
  onControl: RunControl;
  onBusy: (value: string) => void;
  onNotice: (value: string, error?: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("profiles");
  const [result, setResult] = useState<TaskResult>();
  const [running, setRunning] = useState("");
  const [serviceName, setServiceName] = useState("");
  const profiles = props.profiles.filter((row) => `${row.name} ${row.services.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const tasks = props.tasks.filter((row) => `${row.name} ${row.dependencies.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const runTask = async (name: string): Promise<void> => {
    if (props.busy) return;
    setRunning(name);
    setResult(undefined);
    props.onBusy(`Running ${name}…`);
    props.onNotice("");
    try {
      const next = (await postControl("run_task", { name })) as TaskResult;
      setResult(next);
      props.onNotice(next.code === 0 ? `Completed ${name}` : `${name} exited with code ${next.code}`, next.code !== 0);
    } catch (err: unknown) {
      props.onNotice(err instanceof Error ? err.message : "Task failed", true);
    } finally {
      setRunning("");
      props.onBusy("");
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ChoiceGroup
          label="Workspace view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "profiles", label: `Profiles (${props.profiles.length})` },
            { value: "tasks", label: `Tasks (${props.tasks.length})` },
          ]}
        />
        <SearchInput
          label={tab === "profiles" ? "Find a profile or service" : "Find a task"}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          className="w-full sm:w-72"
        />
      </div>
      {tab === "profiles" ? (
        <div className="workspace-cards">
          {profiles.map((row) => {
            const healthy = row.services.filter((name) =>
              props.services.some((service) => service.name === name && serviceIsHealthy(service)),
            ).length;
            return (
              <Card key={row.name}>
                <CardHeader>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <StackIcon className="text-primary" />
                    <CardTitle className="min-w-0 break-all">{row.name}</CardTitle>
                  </div>
                  {row.name === props.profile ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="muted">{row.services.length} services</Badge>
                  )}
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="text-xs text-muted-foreground">
                    {healthy} of {row.services.length} services healthy
                  </p>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${row.services.length ? (healthy / row.services.length) * 100 : 0}%` }}
                    />
                  </div>
                  <details className="profile-members group">
                    <summary>
                      <CaretRightIcon className="size-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                      View {row.services.length} services
                    </summary>
                    <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto pt-3">
                      {row.services.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className="rounded-md bg-muted px-2 py-1 text-xs hover:text-primary"
                          onClick={() => setServiceName(name)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </details>
                  <Button
                    size="sm"
                    disabled={props.busy}
                    onClick={() => props.onControl("start_services", { profile: row.name }, `Starting ${row.name}…`)}
                  >
                    <PlayIcon data-icon="inline-start" />
                    Start profile
                  </Button>
                  <PlanButton profile={row.name} busy={props.busy} onControl={props.onControl} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="workspace-cards">
          {tasks.map((row) => (
            <Card key={row.name}>
              <CardHeader>
                <div className="flex min-w-0 items-center gap-2">
                  <TerminalWindowIcon className="shrink-0 text-primary" />
                  <CardTitle className="break-all">{row.name}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">
                  {row.dependencies.length ? `Starts dependencies: ${row.dependencies.join(", ")}` : "No service dependencies"}
                </p>
                <Button size="sm" variant="outline" disabled={props.busy} onClick={() => void runTask(row.name)}>
                  <PlayIcon data-icon="inline-start" />
                  {running === row.name ? "Running…" : "Run task"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {(tab === "profiles" ? profiles : tasks).length === 0 ? (
        <Card>
          <Empty>
            {search ? "No matches. Try another search." : tab === "profiles" ? "No profiles configured." : "No named tasks configured."}
          </Empty>
        </Card>
      ) : null}
      {serviceName ? (
        <ServiceDetail
          key={serviceName}
          name={serviceName}
          row={props.services.find((row) => row.name === serviceName)}
          config={props.configServices}
          busy={props.busy}
          onControl={props.onControl}
          onClose={() => setServiceName("")}
          onOpenService={setServiceName}
        />
      ) : null}
      {tab === "tasks" && (result || running) ? (
        <Card>
          <CardHeader>
            <CardTitle>Task output · {result?.task || running}</CardTitle>
            {result ? (
              <Badge variant={result.code === 0 ? "success" : "destructive"}>Exit {result.code}</Badge>
            ) : (
              <Badge variant="warning">Running</Badge>
            )}
          </CardHeader>
          <CardContent>
            {result ? (
              <div className="task-output">
                <pre>{result.stdout || "No standard output."}</pre>
                {result.stderr ? <pre className="text-destructive">{result.stderr}</pre> : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Waiting for the task to finish…</p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
