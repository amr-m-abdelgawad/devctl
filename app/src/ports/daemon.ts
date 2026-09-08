import type { DevctlConfig, ServiceConfig } from "../domain/config/types.ts";
import type { Plan } from "../domain/service/services.ts";
import type { ReloadResult, StartRequest, StatusSnapshot } from "../domain/status.ts";
import type { Report } from "../domain/doctor/types.ts";
import type { LifecycleSession } from "./lifecycle-session.ts";

export type HealthController = {
  bumpGeneration(name: string): number;
  onExit(name: string, gen: number, code: number, waitErr?: Error): void;
  startHealth(name: string, svc: ServiceConfig, pid: number, assigned: Record<string, number>, workDir: string, env: Record<string, string>, gen: number): void;
  forget(name: string): void;
  dispose(): void;
  clearHealthWatch(name: string): void;
  clearRestartTimer(name: string): void;
};

export type ServiceOrchestratorPort = {
  bind(session: LifecycleSession): void;
  start(req: StartRequest): Promise<Plan>;
  stop(names: string[]): Promise<void>;
  restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void>;
  serviceIsActive(name: string): boolean;
  readonly health: HealthController;
};

export type DaemonCommands = {
  startService: { execute(req: StartRequest): Promise<Plan> };
  stopService: { execute(names: string[]): Promise<void> };
  restartService: { execute(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string> }): Promise<void> };
  startProxy: { execute(): Promise<void> };
  stopProxy: { execute(): Promise<void> };
  reloadConfig: { execute(): Promise<ReloadResult> };
  refreshIdentity: { execute(): Promise<void> };
  getServiceStatus: { execute(): StatusSnapshot };
  runDoctor: { execute(cfg: DevctlConfig): Promise<Report> };
};
