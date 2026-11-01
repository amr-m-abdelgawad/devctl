import { ServiceTools } from "./service-tools.tsx";
import { PlanButton } from "./plan-button.tsx";
import { useEffect, useState } from "react";
import { fetchService } from "../api.ts";
import { isLiveState, type RunControl } from "../control.ts";
import { hrefFor } from "../hash.ts";
import { useCascadeRestart } from "../hooks/use-cascade-restart.tsx";
import { useStopServices } from "../hooks/use-stop-services.tsx";
import { ScrollIcon } from "../icons.ts";
import type { ConfigService, ServiceDetail as Detail, ServiceRow } from "../types.ts";
import { ActionButtons, EnvSelect } from "./controls.tsx";
import { Empty } from "./primitives.tsx";
import { StatusBadge } from "./status.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

export function ServiceDetail(props: {
  name: string;
  row?: ServiceRow;
  config: ConfigService[];
  busy: boolean;
  onControl: RunControl;
  onClose: () => void;
  onOpenService?: (name: string) => void;
}) {
  const { name, row, config, busy, onControl, onClose, onOpenService } = props;
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const { requestRestart, banner } = useCascadeRestart(config, onControl, busy);
  const { requestStop, confirmation } = useStopServices(config, onControl, busy);
  useEffect(() => {
    let cancelled = false;
    setError("");
    void fetchService(name)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load service");
      });
    return () => {
      cancelled = true;
    };
  }, [name, row?.env, row?.started_env, row?.state, row?.pid]);
  const definition = config.find((service) => service.name === name);
  const shown = detail?.name === name ? detail : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="service-detail-dialog">
        <DialogHeader>
          <DialogTitle className="pr-7 break-all">{name}</DialogTitle>
          <DialogDescription>{definition?.description || "Service details and environment"}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge value={row?.state || shown?.state || "unknown"} />
          <StatusBadge value={row?.health || shown?.health || "unknown"} />
          <span className="font-mono text-xs text-muted-foreground">PID {row?.pid || "—"}</span>
          <div className="ml-auto">
            <ActionButtons
              name={name}
              live={isLiveState(row?.state || "")}
              busy={busy}
              onStart={() => onControl("start_services", { services: [name] }, `Starting ${name}…`)}
              onStop={() => requestStop([name])}
              onRestart={() => requestRestart([name])}
            />
          </div>
        </div>
        <PlanButton services={[name]} busy={busy} onControl={onControl} />
        {banner}
        {confirmation}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {row?.last_error ? <p className="break-words rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{row.last_error}</p> : null}
        {!shown && !error ? (
          <Empty>Loading service details…</Empty>
        ) : shown ? (
          <>
            <dl className="service-facts">
              <div>
                <dt>Command</dt>
                <dd className="font-mono">{shown.command.join(" ") || "—"}</dd>
              </div>
              <div>
                <dt>Working directory</dt>
                <dd className="font-mono">{shown.cwd || "—"}</dd>
              </div>
              <div>
                <dt>Ports</dt>
                <dd className="font-mono">
                  {Object.entries(row?.ports || shown.ports || {})
                    .map(([key, value]) => `${key}:${value}`)
                    .join(" · ") || "None"}
                </dd>
              </div>
              <div>
                <dt>Dependencies</dt>
                <dd>
                  {definition?.dependencies.length
                    ? definition.dependencies.map((dep) => {
                        const target = typeof dep === "string" ? dep : dep.service;
                        return onOpenService ? (
                          <button
                            key={target}
                            type="button"
                            className="mr-3 text-primary hover:underline"
                            onClick={() => onOpenService(target)}
                          >
                            {target}
                          </button>
                        ) : (
                          <a key={target} className="mr-3 text-primary hover:underline" href={hrefFor("services", target)}>
                            {target}
                          </a>
                        );
                      })
                    : "None"}
                </dd>
              </div>
            </dl>
            {row?.environments?.length ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-xs font-medium">Environment overlay</p>
                  <p className="text-[12px] text-muted-foreground">Restart the service to apply a pending change.</p>
                </div>
                <EnvSelect row={row} busy={busy} onControl={onControl} onRestart={(target) => requestRestart([target])} />
              </div>
            ) : null}
            <ServiceTools name={name} env={row?.env} configured={shown.environment} />
          </>
        ) : null}
        <Button variant="outline" asChild>
          <a href={`${hrefFor("logs")}?service=${encodeURIComponent(name)}`}>
            <ScrollIcon data-icon="inline-start" />
            Open service logs
          </a>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
