import { Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { cn } from "../lib/utils.ts";
import type { ProfileRow, TaskRow } from "../types.ts";
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
        <Play />
        Start
      </Button>
      <Button type="button" size="xs" variant="outline" disabled={busy || !live} onClick={onStop}>
        <Square />
        Stop
      </Button>
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRestart}>
        <RotateCw />
        Restart
      </Button>
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
        <Play />
        Start profile
      </Button>
      {hasSelection ? (
        <>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onStartSelected}>Start {selectedCount}</Button>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onStopSelected}>Stop {selectedCount}</Button>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRestartSelected}>
            <RotateCw />
            Restart {selectedCount}
          </Button>
        </>
      ) : (
        <Button type="button" size="xs" variant="outline" disabled={busy || liveCount === 0} onClick={onStopAll}>
          <Square />
          Stop all
        </Button>
      )}
      <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onReload}>
        <RefreshCw />
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
