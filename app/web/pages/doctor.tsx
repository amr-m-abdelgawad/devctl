import { GhostLoader } from "../components/ghost-loader.tsx";
import { describePortFrees, type PortFreeOutcome } from "../../src/application/free-ports.ts";
import { busyPortHolders, FREE_ALL_PORT_MINIMUM } from "../../src/domain/doctor/report.ts";
import type { PortHolder } from "../../src/domain/net/ports.ts";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { useOperatorAction } from "../operator.ts";
import { useCallback, useEffect, useState } from "react";
import { SearchInput, ChoiceGroup } from "../components/filters.tsx";
import { fetchDoctor } from "../api.ts";
import { Empty } from "../components/primitives.tsx";
import { StatusBadge } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { ArrowClockwiseIcon } from "../icons.ts";
import type { DoctorCheck, DoctorReport } from "../types.ts";

export function DoctorPage() {
  const [report, setReport] = useState<DoctorReport | undefined>(undefined);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeFailed, setNoticeFailed] = useState(false);

  const run = useCallback((opts?: { clearNotice?: boolean }): void => {
    setLoading(true);
    setError("");
    if (opts?.clearNotice) {
      setNotice("");
    }
    void fetchDoctor()
      .then((next) => {
        setReport(next);
        setError("");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "doctor failed");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  const busyPorts = busyPortHolders(report?.checks ?? []);
  const okCount = report?.checks.filter((check) => check.severity === "ok").length ?? 0;
  const warnCount = report?.checks.filter((check) => check.severity === "warn").length ?? 0;
  const errorCount = report?.checks.filter((check) => check.severity === "error").length ?? 0;

  const checks = (report?.checks ?? []).filter(
    (check) =>
      (filter !== "issues" || check.severity !== "ok") &&
      `${check.name} ${check.message} ${check.hint || ""}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>Doctor</CardTitle>
            {report ? (
              <Badge variant={report.issues > 0 ? "destructive" : "success"}>
                {report.issues} issue{report.issues === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {busyPorts.length >= FREE_ALL_PORT_MINIMUM ? (
              <FreeAllPorts
                holders={busyPorts}
                disabled={loading}
                onDone={(summary, failed) => {
                  setNotice(summary);
                  setNoticeFailed(failed);
                  run();
                }}
              />
            ) : null}
            <Button type="button" size="xs" variant="outline" disabled={loading} onClick={() => run({ clearNotice: true })}>
              <ArrowClockwiseIcon className={loading ? "animate-spin" : undefined} />
              {loading ? "Running…" : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <p className="text-[13px] text-muted-foreground">
            Run the same diagnostics as devctl doctor. Free one error port, or free every error port, after confirming the process.
          </p>
          {report ? (
            <div className="flex flex-wrap gap-3 text-[13px]">
              <span className="text-success">{okCount} ok</span>
              {warnCount > 0 ? <span className="text-warning">{warnCount} warn</span> : null}
              {errorCount > 0 ? <span className="text-destructive">{errorCount} error</span> : null}
              {warnCount === 0 && errorCount === 0 ? <span className="text-muted-foreground">all clear</span> : null}
            </div>
          ) : null}
          {notice ? (
            <p className={`text-[13px] ${noticeFailed ? "text-destructive" : "text-success"}`} role="status">
              {notice}
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap justify-between gap-3">
            <ChoiceGroup
              label="Diagnostic severity"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All checks" },
                { value: "issues", label: "Issues only" },
              ]}
            />
            <SearchInput
              label="Search checks"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              className="w-full sm:w-72"
            />
          </div>
          {loading ? <DoctorLoading refreshing={Boolean(report)} /> : null}
          {report && report.checks.length === 0 && !loading ? <Empty>No checks reported.</Empty> : null}
          {report && report.checks.length > 0 && checks.length === 0 ? <Empty>No checks match your filters.</Empty> : null}
          <div className={`flex flex-col gap-2 ${loading && report ? "opacity-60" : ""}`}>
            {checks.map((check, index) => (
              <DoctorCheckCard key={`${check.name}-${index}`} check={check} onRefresh={run} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DoctorLoading({ refreshing }: { refreshing: boolean }) {
  return (
    <div className="doctor-loading" role="status" aria-live="polite" aria-busy="true">
      <GhostLoader />
      <p className="text-sm font-medium">devctl doctor</p>
      <p className="text-[13px] text-muted-foreground">{refreshing ? "Refreshing diagnostics…" : "Running diagnostics…"}</p>
    </div>
  );
}

function FreeAllPorts(props: { holders: PortHolder[]; disabled: boolean; onDone: (summary: string, failed: boolean) => void }) {
  const { run, pending } = useOperatorAction();
  return (
    <ConfirmAction
      label={`Free all ${props.holders.length} ports`}
      title={`Stop ${props.holders.length} processes holding error ports?`}
      description={
        <span>
          Each process receives a stop signal. The holder is checked again before any signal, and one failure does not skip the other ports.
          <ul className="mt-2 list-disc pl-4">
            {props.holders.map((holder) => (
              <li key={holder.port}>
                {holder.command || "process"} (pid {holder.pid}) on port {holder.port}
              </li>
            ))}
          </ul>
        </span>
      }
      disabled={props.disabled || pending !== ""}
      destructive
      onConfirm={async () => {
        const response = await run<{ results: PortFreeOutcome[] }>("doctor_free_ports", {
          confirm: true,
          holders: props.holders.map((holder) => ({ port: holder.port, pid: holder.pid, command: holder.command })),
        });
        if (!response) {
          throw new Error("Could not free those ports");
        }
        const failed = response.results.some((row) => row.error !== undefined);
        const summary = describePortFrees(response.results);
        props.onDone(summary, failed);
        if (failed) {
          throw new Error(summary);
        }
      }}
    />
  );
}

function DoctorCheckCard(props: { check: DoctorCheck; onRefresh: () => void }) {
  const { check } = props;
  const { run, error, pending } = useOperatorAction();
  const holder = check.severity === "error" && check.action?.kind === "free-port" ? check.action.holder : undefined;
  return (
    <div className="break-words rounded-lg border border-border/60 bg-muted/20 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={check.severity} />
            <span className="text-sm font-medium">{check.name}</span>
          </div>
          {check.message ? <p className="mt-1.5 text-[14px] text-foreground/90">{check.message}</p> : null}
          {check.hint ? <p className="mt-1 text-[13px] text-info">→ {check.hint}</p> : null}
          {holder ? (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Held by <span className="font-mono text-foreground">{holder.command || "process"}</span> (pid {holder.pid}) on port {holder.port}.
            </p>
          ) : null}
          {error ? (
            <p className="mt-1.5 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {holder ? (
          <ConfirmAction
            label={`Free port ${holder.port}`}
            title={`Stop process ${holder.pid} on port ${holder.port}?`}
            description={
              <span>{holder.command || "Process"} will receive a stop signal. The port holder is rechecked before any signal is sent.</span>
            }
            disabled={Boolean(pending)}
            destructive
            onConfirm={async () => {
              const result = await run("doctor_free_port", { ...holder, confirm: true });
              if (result) props.onRefresh();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
