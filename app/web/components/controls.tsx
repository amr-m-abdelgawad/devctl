import { ArrowClockwiseIcon, ArrowsClockwiseIcon, PlayIcon, StopIcon } from "../icons.ts";
import { cn } from "../lib/utils.ts";
import { envNeedsRestart, isLiveState, type RunControl } from "../control.ts";
import type { ProfileRow, ServiceRow, TaskRow } from "../types.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

export function ActionButtons(props: {
  live: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const { live, busy, onStart, onStop, onRestart } = props;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" size="xs" variant="outline" disabled={busy || live} onClick={onStart}>
        <PlayIcon />
        Start
      </Button>
      <Button type="button" size="xs" variant="outline" disabled={busy || !live} onClick={onStop}>
        <StopIcon />
        Stop
      </Button>
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRestart}>
        <ArrowsClockwiseIcon />
        Restart
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
          <option key={name} value={name}>{name}</option>
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

export function FleetBar(props: {
  profiles: ProfileRow[];
  profile: string;
  tasks: TaskRow[];
  busy: boolean;
  selectedCount: number;
  liveCount: number;
  onProfile: (name: string) => void;
  onStartProfile: () => void;
  onStartSelected: () => void;
  onStopSelected: () => void;
  onRestartSelected: () => void;
  onStopAll: () => void;
  onReload: () => void;
  onRunTask: (name: string) => void;
}) {
  const {
    profiles,
    profile,
    tasks,
    busy,
    selectedCount,
    liveCount,
    onProfile,
    onStartProfile,
    onStartSelected,
    onStopSelected,
    onRestartSelected,
    onStopAll,
    onReload,
    onRunTask,
  } = props;
  const hasSelection = selectedCount > 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Profile
        <select
          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
          value={profile}
          disabled={busy || profiles.length === 0}
          onChange={(event) => onProfile(event.target.value)}
        >
          {profiles.length === 0 ? <option value="">(none)</option> : null}
          {profiles.map((row) => (
            <option key={row.name} value={row.name}>{row.name}</option>
          ))}
        </select>
      </label>
      <Button type="button" size="xs" disabled={busy || !profile} onClick={onStartProfile}>
        <PlayIcon />
        Start profile
      </Button>
      {hasSelection ? (
        <>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onStartSelected}>Start {selectedCount}</Button>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onStopSelected}>Stop {selectedCount}</Button>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRestartSelected}>
            <ArrowsClockwiseIcon />
            Restart {selectedCount}
          </Button>
        </>
      ) : (
        <Button type="button" size="xs" variant="outline" disabled={busy || liveCount === 0} onClick={onStopAll}>
          <StopIcon />
          Stop all
        </Button>
      )}
      <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onReload}>
        <ArrowClockwiseIcon />
        Reload
      </Button>
      {tasks.map((task) => (
        <Button key={task.name} type="button" size="xs" variant="ghost" disabled={busy} onClick={() => onRunTask(task.name)}>
          Run {task.name}
        </Button>
      ))}
    </div>
  );
}

export function ControlNotice(props: { busy: string; notice: string }) {
  const { busy, notice } = props;
  if (!busy && !notice) {
    return null;
  }
  return (
    <p
      className={cn(
        "max-w-[420px] truncate text-[11px]",
        busy ? "text-primary" : notice.toLowerCase().includes("fail") || notice.toLowerCase().includes("error") ? "text-destructive" : "text-muted-foreground",
      )}
      title={busy || notice}
    >
      {busy ? busy : notice}
    </p>
  );
}
