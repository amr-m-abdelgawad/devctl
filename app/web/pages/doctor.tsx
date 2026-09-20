import { useCallback, useEffect, useState } from "react";
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
  const [loading, setLoading] = useState(false);

  const run = useCallback((): void => {
    setLoading(true);
    setError("");
    void fetchDoctor().then((next) => {
      setReport(next);
      setError("");
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "doctor failed");
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  const okCount = report?.checks.filter((check) => check.severity === "ok").length ?? 0;
  const warnCount = report?.checks.filter((check) => check.severity === "warn").length ?? 0;
  const errorCount = report?.checks.filter((check) => check.severity === "error").length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>Doctor</CardTitle>
            {report ? <Badge variant={report.issues > 0 ? "destructive" : "success"}>{report.issues} issue{report.issues === 1 ? "" : "s"}</Badge> : null}
          </div>
          <Button type="button" size="xs" variant="outline" disabled={loading} onClick={run}>
            <ArrowClockwiseIcon />
            {loading ? "Running…" : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <p className="text-[12px] text-muted-foreground">
            Same checks as `devctl doctor`. Busy-port cleanup stays in the TUI/CLI — this page shows the holder and hint only.
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
          <div className="flex flex-col gap-2">
            {(report?.checks ?? []).map((check, index) => (
              <DoctorCheckCard key={`${check.name}-${index}`} check={check} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DoctorCheckCard(props: { check: DoctorCheck }) {
  const { check } = props;
  const holder = check.action?.kind === "free-port" ? check.action.holder : undefined;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge value={check.severity} />
        <span className="text-sm font-medium">{check.name}</span>
      </div>
      {check.message ? <p className="mt-1.5 text-[13px] text-foreground/90">{check.message}</p> : null}
      {check.hint ? <p className="mt-1 text-[12px] text-info">→ {check.hint}</p> : null}
      {holder ? (
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          Held by <span className="font-mono text-foreground">{holder.command || "process"}</span>
          {" "}(pid {holder.pid}) on port {holder.port}. Stop it from the TUI Doctor screen or the CLI — the web console cannot kill processes.
        </p>
      ) : null}
    </div>
  );
}
