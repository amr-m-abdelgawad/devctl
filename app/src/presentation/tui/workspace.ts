import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { DoctorProgress, DoctorRuntimeContext, Report } from "../../domain/doctor/types.ts";
import type { DevctlConfig } from "../../domain/config/types.ts";
import type { Plan, resolveStartRequest } from "../../domain/service/services.ts";

export type TuiWorkspace = Omit<ClientRuntime, "runDoctor"> & {
  runDoctor(cfg: DevctlConfig, onProgress?: (progress: DoctorProgress) => void, runtime?: DoctorRuntimeContext): Promise<Report>;
  startupPlan(cfg: DevctlConfig, selected: string[], profile: string): Plan;
  shutdownPlan(cfg: DevctlConfig, selected: string[]): Plan;
  resolveStartRequest: typeof resolveStartRequest;
};

export function createTuiWorkspace(client: ClientRuntime): TuiWorkspace {
  return {
    ...client,
    runDoctor: (cfg, onProgress, runtime) => client.runDoctor.execute(cfg, onProgress, runtime),
    startupPlan: (cfg, selected, profile) => client.getStartupPlan.execute(cfg, selected, profile),
    shutdownPlan: (cfg, selected) => client.getShutdownPlan.execute(cfg, selected),
    resolveStartRequest: (cfg, req) => client.resolveStart.execute(cfg, req),
  };
}
