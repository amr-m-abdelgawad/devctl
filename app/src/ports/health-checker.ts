import type { ServiceHealth } from "../domain/service/services.ts";
import type { HealthCheckConfig } from "../domain/config/types.ts";

export type HealthCheckResult = {
  status: ServiceHealth;
  message: string;
};

export type HealthCheckContext = {
  pid: number;
  ports: Record<string, number>;
  workDir: string;
  env: Record<string, string>;
};

export type HealthChecker = {
  check(cfg: HealthCheckConfig, ctx: HealthCheckContext): Promise<HealthCheckResult>;
};

export type HealthCheckerFactory = {
  lookup(type: string): HealthChecker | undefined;
};
