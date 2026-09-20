import { RestartAlways, RestartNever, RestartOnFailure, effectiveRestartPolicy, type ServiceConfig } from "../config/types.ts";

export const DEFAULT_MAX_RETRIES = 3;
export const HEALTH_RESTART_STREAK = 3;
export const HEALTH_RESET_STREAK = 10;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export type RestartContext = {
  policy: string;
  enabled: boolean;
  exitCode: number;
  retryCount: number;
  maxRetries: number;
};

export const RestartPolicy = {
  shouldRestart(ctx: RestartContext): boolean {
    if (!ctx.enabled || ctx.policy === RestartNever) {
      return false;
    }
    if (ctx.retryCount >= ctx.maxRetries) {
      return false;
    }
    if (ctx.policy === RestartAlways) {
      return true;
    }
    return ctx.policy === RestartOnFailure && ctx.exitCode !== 0;
  },

  fromService(svc: ServiceConfig, retryCount: number, exitCode: number): RestartContext {
    const policy = effectiveRestartPolicy(svc.restart);
    return {
      policy,
      enabled: svc.restart.enabled !== false,
      exitCode,
      retryCount,
      maxRetries: svc.restart.max_retries > 0 ? svc.restart.max_retries : DEFAULT_MAX_RETRIES,
    };
  },
};

export const StartupPolicy = {
  timeoutMs(svc: ServiceConfig, fallbackMs: number): number {
    const seconds = svc.startup.timeout_seconds;
    return seconds > 0 ? seconds * 1000 : fallbackMs;
  },

  waitForHealthy(svc: ServiceConfig): boolean {
    return svc.startup.wait_for_healthy;
  },
};

export const HealthPolicy = {
  shouldRestartUnhealthy(unhealthyStreak: number, threshold = HEALTH_RESTART_STREAK): boolean {
    return unhealthyStreak >= threshold;
  },

  shouldResetRestartBudget(healthyStreak: number, threshold = HEALTH_RESET_STREAK): boolean {
    return healthyStreak >= threshold;
  },

  // Unhealthy results during this window do not mark the service down or
  // consume restart budget. wait_for_healthy uses the same window so a slow
  // first bind cannot race the startup wait and kill the process.
  probeGraceMs(svc: ServiceConfig, fallbackStartupMs = DEFAULT_STARTUP_TIMEOUT_MS): number {
    const startPeriod = Math.max(0, svc.health.start_period_seconds) * 1000;
    const wait = StartupPolicy.waitForHealthy(svc) ? StartupPolicy.timeoutMs(svc, fallbackStartupMs) : 0;
    return Math.max(startPeriod, wait);
  },
};
