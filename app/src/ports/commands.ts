import type { DevctlConfig } from "../domain/config/types.ts";
import type { Plan } from "../domain/service/services.ts";
import type { ReloadResult, StartRequest, StatusSnapshot } from "../domain/status.ts";
import type { Report } from "../domain/doctor/types.ts";
import type { ServiceOrchestratorPort } from "./orchestrator.ts";

export type DaemonCommandHost = Pick<ServiceOrchestratorPort, "start" | "stop" | "restart"> & {
  reload(): Promise<ReloadResult>;
  snapshot(): StatusSnapshot;
  startProxy(): Promise<void>;
  stopProxy(): Promise<void>;
  refreshIdentity(opts?: { probeServiceAccounts?: boolean }): Promise<void>;
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
