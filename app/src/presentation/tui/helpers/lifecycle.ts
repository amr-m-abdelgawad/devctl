import { type DevctlConfig, dependencyCondition, dependencyName } from "../../../domain/config/types.ts";
import { dependentsClosure, type Plan, type Runtime } from "../../../domain/service/services.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { type LifecycleKind } from "../types.ts";
import { isActiveRuntime, serviceLineState } from "./services.ts";

/** Dependents that a cascading restart would add beyond the named services. */
export function restartDependents(cfg: DevctlConfig, targets: string[]): string[] {
  if (targets.length === 0) {
    return [];
  }
  const named = new Set(targets);
  return dependentsClosure(cfg, targets).filter((name) => !named.has(name));
}

export function planServices(
  cfg: DevctlConfig,
  targets: string[],
  profileName: string,
): { services: string[]; profile: string } {
  const profile = profileName !== "" && cfg.profiles[profileName] ? profileName : "";
  if (targets.length > 0) {
    return { services: targets, profile };
  }
  if (profile !== "") {
    return { services: [...(cfg.profiles[profileName]?.services ?? [])], profile };
  }
  return { services: Object.keys(cfg.services), profile: "" };
}

export function alreadyUpNames(plan: Plan, snap?: StatusSnapshot): string[] {
  return plan.waves.flat().filter((name) => isActiveRuntime(snap?.services[name]));
}

export function pendingPlanWaves(plan: Plan, snap?: StatusSnapshot): string[][] {
  return plan.waves
    .map((wave) => wave.filter((name) => !isActiveRuntime(snap?.services[name])))
    .filter((wave) => wave.length > 0);
}

export function formatPlanSummary(plan: Plan): string {
  return plan.waves.flat().join(" → ");
}

export function formatStarted(plan: Plan): string {
  const summary = formatPlanSummary(plan);
  if (summary === "") {
    return "Started selected services";
  }
  return `Started ${summary}`;
}

export function formatStopped(plan: Plan): string {
  const summary = formatPlanSummary(plan);
  if (summary === "") {
    return "Stopped running services";
  }
  return `Stopped ${summary}`;
}

export function planHeadline(plan: Plan, busy: boolean, failed: string, kind: LifecycleKind = "start"): string {
  const verb = kind === "stop" ? "Stop" : kind === "restart" ? "Restart" : "Start";
  if (failed) {
    return `${verb} failed on ${failed}`;
  }
  if (busy) {
    if (kind === "stop") {
      return "Stopping services";
    }
    if (kind === "restart") {
      return plan.profile ? `Restarting profile ${plan.profile}` : "Restarting selected services";
    }
    return plan.profile ? `Starting profile ${plan.profile}` : "Starting selected services";
  }
  if (kind === "stop") {
    return "Stopped";
  }
  if (kind === "restart") {
    return plan.profile ? `Restarted profile ${plan.profile}` : "Restart finished";
  }
  return plan.profile ? `Started profile ${plan.profile}` : "Start finished";
}

export function planRowNote(name: string, plan: Plan, snap?: StatusSnapshot, kind: LifecycleKind = "start"): string {
  const rt = snap?.services[name];
  const state = serviceLineState(rt);
  if (rt?.last_error && kind !== "stop") {
    return rt.last_error;
  }
  if (kind === "stop") {
    if (state === "STOPPED") {
      return "stopped";
    }
    if (state === "STOPPING") {
      return "stopping now";
    }
    if (state === "FAILED") {
      return "already failed";
    }
    return "queued";
  }
  if (state === "HEALTHY") {
    return "ready";
  }
  if (state === "STARTING") {
    return "starting now";
  }
  if (state === "RUNNING") {
    return "up, waiting for health";
  }
  if (state === "UNHEALTHY") {
    return "unhealthy — retrying health check";
  }
  if (state === "STOPPING") {
    return "stopping first";
  }
  if (state === "FAILED") {
    return "failed — later waves will not start";
  }
  const step = plan.steps.find((s) => s.name === name);
  const pending = (step?.dependencies ?? []).filter((dep) => {
    const depState = serviceLineState(snap?.services[dependencyName(dep)]);
    return dependencyCondition(dep) === "service_healthy"
      ? depState !== "HEALTHY"
      : depState === "STOPPED" || depState === "FAILED";
  }).map(dependencyName);
  if (pending.length > 0) {
    return `waits for ${pending.join(", ")}`;
  }
  return "queued";
}

export function planNextAction(busy: boolean, failed: string, kind: LifecycleKind = "start"): string {
  if (busy) {
    if (kind === "stop") {
      return "Stopping dependents first.  esc  hide this panel";
    }
    if (kind === "restart") {
      return "Stop first, then start in order.  esc  hide this panel";
    }
    return "Later waves wait until this wave is healthy.  esc  hide this panel";
  }
  if (failed) {
    const retry = kind === "stop" ? "try /stop again" : "/start again";
    return `Fix ${failed}, then ${retry}.  enter or esc  back to dashboard`;
  }
  return "Finished.  enter or esc  back to dashboard";
}

export type WaveStatus = "completed" | "active" | "unhealthy" | "failed" | "queued";

export function waveStatus(wave: string[], snap?: StatusSnapshot, kind: LifecycleKind = "start"): WaveStatus {
  if (wave.length === 0) {
    return "completed";
  }
  const runtimes = wave.map((name) => snap?.services[name]);
  if (runtimes.some((rt) => rt?.state === "FAILED")) {
    return "failed";
  }
  if (kind === "stop") {
    if (runtimes.every((rt) => !rt || rt.state === "STOPPED" || rt.state === "UNKNOWN")) {
      return "completed";
    }
    if (runtimes.some((rt) => rt?.state === "STOPPING")) {
      return "active";
    }
    return "queued";
  }
  const isHealthy = (rt?: Runtime): boolean =>
    Boolean(rt && (rt.state === "HEALTHY" || rt.health === "HEALTHY" || (rt.state === "RUNNING" && rt.health !== "UNHEALTHY")));
  if (runtimes.every(isHealthy)) {
    return "completed";
  }
  if (runtimes.some((rt) => rt?.state === "UNHEALTHY" || rt?.health === "UNHEALTHY")) {
    return "unhealthy";
  }
  if (runtimes.some((rt) => rt?.state === "STARTING" || rt?.state === "RUNNING" || rt?.state === "RESTARTING")) {
    return "active";
  }
  return "queued";
}

export type PlanProgressInfo = {
  total: number;
  ready: number;
  active: number;
  failed: number;
  percent: number;
  progressBar: string;
  currentWaveIndex: number;
  totalWaves: number;
  isComplete: boolean;
};

export function planProgress(plan: Plan, snap?: StatusSnapshot, kind: LifecycleKind = "start"): PlanProgressInfo {
  const allServices = plan.waves.flat();
  const total = allServices.length;
  let ready = 0;
  let failed = 0;
  let active = 0;
  let currentWaveIndex = 0;

  for (let i = 0; i < plan.waves.length; i++) {
    const wave = plan.waves[i] ?? [];
    const st = waveStatus(wave, snap, kind);
    if (st === "active" || st === "unhealthy" || st === "failed") {
      currentWaveIndex = i;
    } else if (st === "completed" && currentWaveIndex === i && i < plan.waves.length - 1) {
      currentWaveIndex = i + 1;
    }
    for (const name of wave) {
      const rt = snap?.services[name];
      const isDone =
        kind === "stop"
          ? !rt || rt.state === "STOPPED" || rt.state === "UNKNOWN"
          : Boolean(rt && (rt.state === "HEALTHY" || rt.health === "HEALTHY" || (rt.state === "RUNNING" && rt.health !== "UNHEALTHY")));
      if (isDone) {
        ready++;
      } else if (rt?.state === "FAILED") {
        failed++;
      } else if (
        rt?.state === "STARTING" ||
        rt?.state === "RUNNING" ||
        rt?.state === "UNHEALTHY" ||
        rt?.health === "UNHEALTHY" ||
        rt?.state === "STOPPING" ||
        rt?.state === "RESTARTING"
      ) {
        active++;
      }
    }
  }

  const percent = total > 0 ? Math.round((ready / total) * 100) : 100;
  const barLen = 16;
  const filled = Math.round((percent / 100) * barLen);
  const progressBar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
  const isComplete = ready === total && total > 0;

  return {
    total,
    ready,
    active,
    failed,
    percent,
    progressBar,
    currentWaveIndex,
    totalWaves: plan.waves.length,
    isComplete,
  };
}

export function waveCardTitle(kind: LifecycleKind, waveIdx: number, st: WaveStatus): string {
  const statusLabel =
    st === "completed"
      ? "✓ Completed"
      : st === "failed"
        ? "✗ Failed"
        : st === "unhealthy"
          ? "⚠ Unhealthy"
          : st === "active"
            ? "⏳ In Progress"
            : "○ Queued";
  const orderLabel =
    kind === "stop"
      ? waveIdx === 0
        ? "Wave 1 (Stop First)"
        : `Wave ${waveIdx + 1}`
      : waveIdx === 0
        ? "Wave 1 (Start First)"
        : `Wave ${waveIdx + 1}`;
  return `${orderLabel} · ${statusLabel}`;
}

export function planTitle(kind: LifecycleKind, busy: boolean, failed: string, profile?: string): string {
  const profileSuffix = profile ? ` · Profile ${profile}` : "";
  if (failed) {
    return `${kind === "stop" ? "Shutdown" : "Startup"} Failed (${failed})`;
  }
  if (busy) {
    return `${kind === "stop" ? "Stopping Services" : kind === "restart" ? "Restarting Pipeline" : "Starting Pipeline"}${profileSuffix}`;
  }
  return `${kind === "stop" ? "Shutdown Complete" : "Startup Complete"}${profileSuffix}`;
}

export function planActionCopy(busy: boolean, failed: string): { primary: string; secondary: string } {
  if (busy) {
    return {
      primary: "Working…  esc  hide this panel (keeps running in background)",
      secondary: "Services are transitioning. You can dismiss anytime without stopping them.",
    };
  }
  if (failed) {
    return {
      primary: "enter or esc  back to dashboard",
      secondary: "Execution stopped. Check logs or open Doctor to resolve errors.",
    };
  }
  return {
    primary: "enter or esc  back to dashboard",
    secondary: "All waves finished. Click here or press enter to continue.",
  };
}
