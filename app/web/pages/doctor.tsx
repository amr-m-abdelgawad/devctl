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

  const run = useCallback((): void => {
    setLoading(true);
    setError("");
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
          <Button type="button" size="xs" variant="outline" disabled={loading} onClick={run}>
            <ArrowClockwiseIcon />
            {loading ? "Running…" : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <p className="text-[12px] text-muted-foreground">
            Run the same diagnostics as devctl doctor. Review busy-port holders and free a port after confirming the process.
          </p>
          {report ? (
            <div className="flex flex-wrap gap-3 text-[12px]">
              <span className="text-success">{okCount} ok</span>
              {warnCount > 0 ? <span className="text-warning">{warnCount} warn</span> : null}
              {errorCount > 0 ? <span className="text-destructive">{errorCount} error</span> : null}
              {warnCount === 0 && errorCount === 0 ? <span className="text-muted-foreground">all clear</span> : null}
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {loading && !report ? <Empty>Running diagnostics…</Empty> : null}
          {report && report.checks.length === 0 && !loading ? <Empty>No checks reported.</Empty> : null}
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
          {report && report.checks.length > 0 && checks.length === 0 ? <Empty>No checks match your filters.</Empty> : null}
          <div className="flex flex-col gap-2">
            {checks.map((check, index) => (
              <DoctorCheckCard key={`${check.name}-${index}`} check={check} onRefresh={run} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DoctorCheckCard(props: { check: DoctorCheck; onRefresh: () => void }) {
  const { check } = props;
  const { run, error, pending } = useOperatorAction();
  const holder = check.action?.kind === "free-port" ? check.action.holder : undefined;
  return (
    <div className="break-words rounded-lg border border-border/60 bg-muted/20 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge value={check.severity} />
        <span className="text-sm font-medium">{check.name}</span>
      </div>
      {check.message ? <p className="mt-1.5 text-[13px] text-foreground/90">{check.message}</p> : null}
      {check.hint ? <p className="mt-1 text-[12px] text-info">→ {check.hint}</p> : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {holder ? (
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          Held by <span className="font-mono text-foreground">{holder.command || "process"}</span> (pid {holder.pid}) on port {holder.port}.
          Review the process below before freeing this port.
        </p>
      ) : null}
      {holder ? (
        <div className="mt-3">
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
        </div>
      ) : null}
    </div>
  );
}
