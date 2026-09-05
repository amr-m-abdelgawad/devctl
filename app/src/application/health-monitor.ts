import type { ServiceConfig } from "../domain/config/types.ts";
import { DEFAULT_MAX_RETRIES, HealthPolicy, RestartPolicy } from "../domain/service/policies.ts";
import { HealthHealthy, HealthUnhealthy, HealthUnknown, StateFailed, StateHealthy, StateUnhealthy, StateRestarting, StateRunning, StateStopping, StateStopped, type ServiceHealth } from "../domain/service/services.ts";
import type { Clock } from "../ports/clock.ts";
import type { ProcessRuntime } from "../ports/process-runtime.ts";
import { humanMessage, newError } from "../shared/errors.ts";
import { ServiceStopped, ServiceHealthChanged, newEvent } from "../shared/events.ts";
import type { LifecycleSession } from "./lifecycle-session.ts";

const DEFAULT_BACKOFF_SECONDS = 2;
const DEFAULT_HEALTH_INTERVAL_MS = 2000;
const HEALTH_RESTART_STREAK = 3;
const HEALTH_RESET_STREAK = 10;

/** Owns health probes and the shared crash/unhealthy restart budget. */
export class HealthMonitor {
  private readonly generation = new Map<string, number>();
  private readonly healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly restarts = new Map<string, number>();
  private readonly unhealthyStreak = new Map<string, number>();
  private readonly healthyStreak = new Map<string, number>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly host: () => LifecycleSession,
    private readonly processes: ProcessRuntime,
    private readonly clock: Clock,
    private readonly actions: {
      startOne(name: string, profile: string, env: Record<string, string>, hooks: boolean): Promise<void>;
      restart(names: string[], opts: { auto: boolean }): Promise<void>;
    },
  ) {}

  forget(name: string): void {
    this.clearHealthWatch(name);
    this.clearRestartTimer(name);
    this.restarts.delete(name);
    // Keep a tombstone so a removed and re-added name cannot reuse an epoch
    // still held by an in-flight health check or exit callback.
    this.bumpGeneration(name);
    this.unhealthyStreak.delete(name);
    this.healthyStreak.delete(name);
  }

  dispose(): void {
    this.clearAllRestartTimers();
    for (const name of this.generation.keys()) this.bumpGeneration(name);
    for (const name of this.healthTimers.keys()) this.clearHealthWatch(name);
  }

  onExit(name: string, gen: number, code: number, waitErr?: Error): void {
    // This exit belongs to a process from an epoch stop()/fail()/a newer
    // start already ended — whatever it implies about restart policy no
    // longer applies to whatever (if anything) currently holds this name.
    if (!this.isCurrentGeneration(name, gen)) {
      return;
    }
    const rt = this.host().runtimes.get(name);
    if (rt?.state === StateFailed) {
      // fail() already set this state and is in the middle of killing the
      // process on purpose (e.g. a startup health-check timeout); the exit
      // that kill produces must not be treated as a crash to restart from.
      return;
    }
    if (rt && (rt.state === StateStopping || rt.state === StateStopped)) {
      this.host().setState(name, StateStopped, HealthUnknown, 0, "");
      this.host().bus.publish(newEvent(ServiceStopped, name, { code }));
      return;
    }
    const svc = this.host().cfg.services[name];
    const msg = waitErr?.message ?? `exited with code ${code}`;
    const n = this.restarts.get(name) ?? 0;
    const should = svc
      ? RestartPolicy.shouldRestart(RestartPolicy.fromService(svc, n, code))
      : false;
    if (should && svc) {
      this.host().setState(name, StateRestarting, HealthUnknown, 0, msg);
      this.bumpRestartCount(name, n + 1);
      // The process that just exited is already gone from procs.all() (the
      // ProcessManager removes it before invoking this callback), so this
      // promptly clears its now-dead pid from disk instead of leaving a
      // stale record there until some unrelated later event persists again.
      this.host().persistState();
      this.armRestart(name, svc, gen, n, () => {
        // Use this service's own last-tracked profile context, not the
        // daemon-wide fallback — an unrelated service started under a
        // different profile in the meantime must not change what this one
        // crash-restarts with.
        const profile = this.host().serviceProfile.get(name) ?? this.host().profile;
        const profileEnv = this.host().serviceProfileEnv.get(name) ?? this.host().profileEnv;
        void this.actions.startOne(name, profile, profileEnv, false).catch((err) => this.host().log(name, "ERROR", humanMessage(err)));
      });
      return;
    }
    void this.host().fail(name, newError("process_start", msg));
  }

  startHealth(
    name: string,
    svc: ServiceConfig,
    pid: number,
    assigned: Record<string, number>,
    workDir: string,
    env: Record<string, string>,
    gen: number,
  ): void {
    const prev = this.healthTimers.get(name);
    if (prev) {
      clearInterval(prev);
    }
    if (svc.health.type === "") {
      this.setHealth(name, HealthHealthy, "no health check");
      return;
    }
    const interval = svc.health.interval_seconds > 0 ? svc.health.interval_seconds * 1000 : DEFAULT_HEALTH_INTERVAL_MS;
    const startedAt = Date.parse(this.host().runtimes.get(name)?.startTime ?? "") || this.clock.unixMs();
    const tick = (): void => {
      const healthResult: Promise<{ status: ServiceHealth; message: string }> = svc.container && svc.health.type.toLowerCase() === "process"
        ? Promise.resolve(this.processes.isRunning(name)
          ? { status: HealthHealthy, message: "container running" }
          : { status: HealthUnhealthy, message: "container not running" })
        : Promise.resolve().then(() => this.host().healthCheckers.lookup(svc.health.type)?.check(svc.health, { pid, ports: assigned, workDir, env }) ?? { status: HealthUnhealthy, message: `unknown health type ${svc.health.type}` });
      void healthResult
        .catch((err: unknown) => ({ status: HealthUnhealthy, message: humanMessage(err) }) as const)
        .then((res) => {
          // A slow check (e.g. an HTTP request against a hung endpoint) can
          // still be in flight when this service crashes and restarts under
          // a new pid; without this guard its stale result would land on
          // whatever process now holds this service's name instead.
          if (!this.isCurrentGeneration(name, gen)) {
            return;
          }
          if (res.status === HealthUnhealthy && this.clock.unixMs() - startedAt < svc.health.start_period_seconds * 1000) {
            this.host().logs.append({ timestamp: this.clock.isoNow(), service: name, source: "health", level: "INFO", message: `health check still in start period: ${res.message}`, pid });
            return;
          }
          this.setHealth(name, res.status, res.message);
          this.host().logs.append({
            timestamp: this.clock.isoNow(),
            service: name,
            source: "health",
            level: healthLevel(res.status),
            message: `health ${res.status} ${res.message}`,
            pid,
          });
          this.maybeRestartUnhealthy(name, svc, res.status, gen);
        });
    };
    tick();
    this.healthTimers.set(name, setInterval(tick, interval));
  }

  // this.restarts (the private retry-budget counter) and Runtime.restarts
  // (the field sent to clients) must stay in sync — bump both together so
  // status snapshots reflect real restart counts instead of always 0.
  private bumpRestartCount(name: string, n: number): void {
    this.restarts.set(name, n);
    const rt = this.host().runtimes.get(name);
    if (rt) {
      rt.restarts = n;
    }
  }

  // A manual stop or start is the caller taking explicit control of this
  // service; whatever crash history it had stops mattering from here — it
  // gets a fresh restart budget rather than staying close to max_retries
  // because of failures from before this intervention.
  resetRestartCount(name: string): void {
    this.healthyStreak.set(name, 0);
    this.bumpRestartCount(name, 0);
  }

  // Ends the current lifecycle epoch for a service: any exit, health-check,
  // or scheduled-restart callback still holding an older generation number
  // is now stale and must recognize that via isCurrentGeneration() rather
  // than act on state that belongs to a different process.
  bumpGeneration(name: string): number {
    const next = (this.generation.get(name) ?? 0) + 1;
    this.generation.set(name, next);
    // A new epoch starts its own healthy streak from zero — otherwise a
    // streak built up before a crash could carry over and forgive that very
    // crash's restart-count bump on the next tick, without the service ever
    // actually proving itself stable again under the new process.
    this.healthyStreak.set(name, 0);
    return next;
  }

  isCurrentGeneration(name: string, gen: number): boolean {
    return this.generation.get(name) === gen;
  }

  // Crash restarts (onExit) and unhealthy restarts (maybeRestartUnhealthy)
  // both schedule a delayed respawn via setTimeout. Tracking the handle lets
  // stop/fail/shutdown cancel it — otherwise a restart scheduled moments
  // before the service is deliberately stopped or fails outright can still
  // fire afterward and resurrect a process the caller just asked to end.
  private scheduleRestart(name: string, delayMs: number, action: () => void): void {
    this.clearRestartTimer(name);
    const timer = setTimeout(() => {
      this.restartTimers.delete(name);
      action();
    }, delayMs);
    this.restartTimers.set(name, timer);
  }

  // Shared by crash-triggered (onExit) and health-triggered
  // (maybeRestartUnhealthy) restarts: computes backoff from the pre-bump
  // attempt count and arms the timer, guarding the eventual fire against a
  // generation that has since moved on — a manual stop/start/restart, or a
  // fail(), already happened for this service — so a stale scheduled
  // restart from a superseded epoch never fires.
  private armRestart(name: string, svc: ServiceConfig, gen: number, attempt: number, action: () => void): void {
    const backoff = svc.restart.backoff_seconds > 0 ? svc.restart.backoff_seconds : DEFAULT_BACKOFF_SECONDS;
    this.scheduleRestart(name, backoff * (2 ** attempt) * 1000, () => {
      if (this.isCurrentGeneration(name, gen)) {
        action();
      }
    });
  }

  clearRestartTimer(name: string): void {
    const timer = this.restartTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(name);
    }
  }

  clearAllRestartTimers(): void {
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
  }

  private setHealth(name: string, health: ServiceHealth, message: string): void {
    const rt = this.host().runtimes.get(name);
    if (!rt) {
      return;
    }
    rt.health = health;
    if (rt.state === StateRunning || rt.state === StateHealthy || rt.state === StateUnhealthy) {
      rt.state = health === HealthHealthy ? StateHealthy : health === HealthUnhealthy ? StateUnhealthy : rt.state;
    }
    this.host().bus.publish(newEvent(ServiceHealthChanged, name, { health, message }));
  }

  private maybeRestartUnhealthy(name: string, svc: ServiceConfig, health: ServiceHealth, gen: number): void {
    if (health !== HealthUnhealthy) {
      this.unhealthyStreak.set(name, 0);
      if (health === HealthHealthy) {
        this.maybeForgiveRestarts(name, svc);
      }
      return;
    }
    this.healthyStreak.set(name, 0);
    const policy = svc.restart.policy || (svc.restart.enabled ? "on_failure" : "never");
    if (policy !== "on_failure" && policy !== "always") {
      return;
    }
    // A restart is already committed and waiting for its backoff. Further
    // probes from the same process must not consume more retry budget or
    // continually push that timer back.
    if (this.restartTimers.has(name)) return;
    const streak = (this.unhealthyStreak.get(name) ?? 0) + 1;
    this.unhealthyStreak.set(name, streak);
    const threshold = svc.health.unhealthy_threshold > 0 ? svc.health.unhealthy_threshold : HEALTH_RESTART_STREAK;
    if (!HealthPolicy.shouldRestartUnhealthy(streak, threshold)) {
      return;
    }
    this.unhealthyStreak.set(name, 0);
    // Share the same restart budget and backoff as crash-triggered restarts
    // (onExit) so a service that is merely unhealthy but never exits can't
    // restart forever at a fixed 3-checks-per-restart cadence.
    const n = this.restarts.get(name) ?? 0;
    const max = svc.restart.max_retries > 0 ? svc.restart.max_retries : DEFAULT_MAX_RETRIES;
    if (n >= max) {
      this.host().log(name, "WARN", `unhealthy after ${streak} consecutive checks but the restart limit (${max}) has already been reached; not restarting`);
      return;
    }
    this.bumpRestartCount(name, n + 1);
    this.host().log(name, "WARN", `restarting after ${streak} consecutive unhealthy checks (attempt ${n + 1}/${max})`);
    this.armRestart(name, svc, gen, n, () => {
      void this.actions.restart([name], { auto: true }).catch((err) => this.host().log(name, "ERROR", humanMessage(err)));
    });
  }

  // Forgives past restarts once a service proves itself stable, so a long
  // healthy run doesn't leave it one stumble away from max_retries because
  // of crashes/unhealthy spells long in its past.
  private maybeForgiveRestarts(name: string, svc: ServiceConfig): void {
    const streak = (this.healthyStreak.get(name) ?? 0) + 1;
    this.healthyStreak.set(name, streak);
    const threshold = svc.health.healthy_reset_threshold > 0 ? svc.health.healthy_reset_threshold : HEALTH_RESET_STREAK;
    if (HealthPolicy.shouldResetRestartBudget(streak, threshold) && (this.restarts.get(name) ?? 0) > 0) {
      this.host().log(name, "INFO", `restart count reset after ${streak} consecutive healthy checks`);
      this.bumpRestartCount(name, 0);
    }
  }

  clearHealthWatch(name: string): void {
    const timer = this.healthTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(name);
    }
  }

}

function healthLevel(status: ServiceHealth): string {
  return status === HealthUnhealthy ? "WARN" : status === HealthHealthy ? "INFO" : "DEBUG";
}
