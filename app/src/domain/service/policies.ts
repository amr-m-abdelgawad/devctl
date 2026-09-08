import { RestartAlways, RestartNever, RestartOnFailure, effectiveRestartPolicy, type ServiceConfig } from "../config/types.ts";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BACKOFF_SECONDS = 2;
export const HEALTH_RESTART_STREAK = 3;
export const HEALTH_RESET_STREAK = 10;

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

export const HealthPolicy = {
  shouldRestartUnhealthy(unhealthyStreak: number, threshold = HEALTH_RESTART_STREAK): boolean {
    return unhealthyStreak >= threshold;
  },

  shouldResetRestartBudget(healthyStreak: number, threshold = HEALTH_RESET_STREAK): boolean {
    return healthyStreak >= threshold;
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

export const ShutdownPolicy = {
  graceMs(seconds: number, fallbackMs: number): number {
    return seconds > 0 ? seconds * 1000 : fallbackMs;
  },
};

export const CredentialRefreshPolicy = {
  shouldRefresh(expiresAt: Date, now: Date, thresholdMs: number): boolean {
    return expiresAt.getTime() - now.getTime() < thresholdMs;
  },
};
