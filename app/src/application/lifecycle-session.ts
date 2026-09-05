import type { DevctlConfig, ServiceConfig } from "../domain/config/types.ts";
import type { Runtime, ServiceHealth, ServiceState } from "../domain/service/services.ts";
import type { LogStore } from "../ports/log-store.ts";
import type { Bus } from "../shared/events.ts";
import type { HealthCheckerFactory } from "../ports/health-checker.ts";

export type GoogleProbe = {
  adcAvailable: boolean;
};

/** Temporary daemon state and infrastructure bridge; lifecycle policy lives in the application. */
export type LifecycleSession = {
  cfg: DevctlConfig;
  profile: string;
  profileEnv: Record<string, string>;
  detached: boolean;
  readonly proxySuppressed: boolean;
  readonly runtimes: Map<string, Runtime>;
  readonly ports: Map<string, Record<string, number>>;
  readonly clientEnv: Map<string, Record<string, string>>;
  readonly serviceProfile: Map<string, string>;
  readonly serviceProfileEnv: Map<string, Record<string, string>>;
  readonly healthCheckers: HealthCheckerFactory;
  readonly logs: LogStore;
  readonly bus: Bus;
  readonly processMeta: Map<string, { command: string[]; cwd: string; startTime: Date }>;
  readonly containerPrefix: string;
  prepareServiceIdentity(name: string, svc: ServiceConfig): Promise<void>;
  resolveServiceExecution(name: string, svc: ServiceConfig, profile: string, profileEnv: Record<string, string>, clientEnv?: Record<string, string>, includeProcess?: boolean): Promise<{ env: Record<string, string>; workDir: string }>;

  detectGoogle(project: string): Promise<GoogleProbe>;
  startProxy(): Promise<void>;
  fail(name: string, err: unknown): Promise<void>;
  claimIfAlreadyUp(name: string): Promise<boolean>;
  assignPendingPorts(pending: string[]): Promise<void>;
  setState(name: string, state: ServiceState, health: ServiceHealth, pid: number, lastError: string): void;
  persistState(): void;
  log(service: string, level: string, message: string): void;
  releasePorts(name: string): Promise<void>;
  forgetService(name: string): void;
};
