import { ArrowsClockwiseIcon, PlayIcon, StopIcon } from "../icons.ts";
import { envNeedsRestart, isLiveState, type RunControl } from "../control.ts";
import type { ServiceRow } from "../types.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

export function ActionButtons(props: {
  name?: string;
  live: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const { live, busy, onStart, onStop, onRestart } = props;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={`${live ? "Stop" : "Start"} ${props.name || "service"}`}
        onClick={live ? onStop : onStart}
      >
        {live ? <StopIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
        {live ? "Stop" : "Start"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        aria-label={`Restart ${props.name || "service"}`}
        title={`Restart ${props.name || "service"}`}
        onClick={onRestart}
      >
        <ArrowsClockwiseIcon />
      </Button>
    </div>
  );
}

export function EnvSelect(props: {
  row: Pick<ServiceRow, "name" | "state" | "env" | "started_env" | "environments">;
  busy: boolean;
  onControl: RunControl;
  onRestart?: (name: string) => void;
}) {
  const { row, busy, onControl, onRestart } = props;
  const names = [...(row.environments ?? [])];
  if (row.env && !names.includes(row.env)) {
    names.unshift(row.env);
  }
  if (names.length === 0) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  const selected = (row.env && names.includes(row.env) ? row.env : names[0]) ?? "";
  const pending = envNeedsRestart({ ...row, env: selected });
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select
        className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
        value={selected}
        disabled={busy}
        aria-label={`Environment for ${row.name}`}
        onChange={(event) => {
          const name = event.target.value;
          if (name === "" || name === row.env) {
            return;
          }
          onControl("set_service_environment", { service: row.name, name }, `Switching ${row.name} to ${name}…`);
        }}
      >
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {pending ? (
        <>
          <Badge variant="warning">pending</Badge>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || !isLiveState(row.state)}
            onClick={() => {
              if (onRestart) {
                onRestart(row.name);
                return;
              }
              onControl("restart_services", { services: [row.name] }, `Restarting ${row.name}…`);
            }}
          >
            Restart
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function ControlNotice(props: { busy: string; notice: string; error?: boolean; onDismiss?: () => void }) {
  if (!props.busy && !props.notice) return null;
  return (
    <div className="flex items-center gap-3">
      <p className={props.error ? "text-xs text-destructive" : "text-xs text-foreground"} role={props.error ? "alert" : undefined}>
        {props.busy || props.notice}
      </p>
      {!props.busy && props.onDismiss ? (
        <Button size="sm" variant="ghost" aria-label="Dismiss notification" onClick={props.onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}
