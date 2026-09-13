import type { ControlArgs, ControlTool } from "./types.ts";

export type RunControl = (tool: ControlTool, args?: ControlArgs, label?: string) => void;

const LIVE_STATES = new Set(["RUNNING", "STARTING", "RESTARTING", "HEALTHY", "UNHEALTHY"]);

export function isLiveState(state: string): boolean {
  return LIVE_STATES.has(state.toUpperCase());
}

type PlanLike = { waves?: unknown };
type ReloadLike = { restart_required?: unknown };
type TaskLike = { task?: unknown; code?: unknown };

function waveNames(result: unknown): string {
  if (!result || typeof result !== "object" || !("waves" in result)) {
    return "";
  }
  const waves = (result as PlanLike).waves;
  if (!Array.isArray(waves)) {
    return "";
  }
  return waves.flat().filter((name): name is string => typeof name === "string").join(" → ");
}

export function noticeFor(tool: ControlTool, result: unknown, args: ControlArgs = {}): string {
  switch (tool) {
    case "start_services": {
      const names = waveNames(result);
      if (args.profile) {
        return names ? `Started profile ${args.profile}: ${names}` : `Started profile ${args.profile}`;
      }
      return names ? `Started ${names}` : "Start finished";
    }
    case "stop_services":
      return args.services && args.services.length > 0
        ? `Stopped ${args.services.join(", ")}`
        : "Stopped running services";
    case "restart_services": {
      const names = args.services && args.services.length > 0 ? args.services.join(", ") : "services";
      return args.cascade ? `Restarted ${names} + dependents` : `Restarted ${names}`;
    }
    case "reload_config": {
      const required = result && typeof result === "object" && "restart_required" in result
        ? (result as ReloadLike).restart_required
        : undefined;
      const names = Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [];
      return names.length > 0 ? `Reloaded — restart ${names.join(", ")}` : "Config reloaded";
    }
    case "run_task": {
      const task = result && typeof result === "object" ? result as TaskLike : {};
      const name = args.name ?? (typeof task.task === "string" ? task.task : "task");
      return typeof task.code === "number" && task.code !== 0 ? `${name} exited ${task.code}` : `Ran ${name}`;
    }
    case "start_proxy":
      return "Proxy started";
    case "stop_proxy":
      return "Proxy stopped";
  }
}
