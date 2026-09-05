import { GetShutdownPlan, GetStartupPlan, ResolveStart, RunDoctor } from "../../application/commands.ts";
import { createDoctorRunner } from "../../adapters/doctor/doctor.ts";
import type { DoctorProgress, DoctorRuntimeContext, Report } from "../../domain/doctor/types.ts";
import { detectGoogle, loginGoogle, logoutGoogle, type GoogleStatus } from "../../adapters/google/google.ts";
import { resolveStartRequest, type Plan } from "../../domain/service/services.ts";
import type { DevctlConfig } from "../../domain/config/types.ts";

export type TuiWorkspace = {
  detectGoogle: (project: string) => Promise<GoogleStatus>;
  loginGoogle: typeof loginGoogle;
  logoutGoogle: typeof logoutGoogle;
  runDoctor: (
    cfg: DevctlConfig,
    onProgress?: (progress: DoctorProgress) => void,
    runtime?: DoctorRuntimeContext,
  ) => Promise<Report>;
  startupPlan: (cfg: DevctlConfig, selected: string[], profile: string) => Plan;
  shutdownPlan: (cfg: DevctlConfig, selected: string[]) => Plan;
  resolveStartRequest: typeof resolveStartRequest;
};

const startup = new GetStartupPlan();
const shutdown = new GetShutdownPlan();
const resolveStart = new ResolveStart();
const doctor = new RunDoctor(createDoctorRunner());

export function createTuiWorkspace(): TuiWorkspace {
  return {
    detectGoogle,
    loginGoogle,
    logoutGoogle,
    runDoctor: (cfg, onProgress, runtime) => doctor.execute(cfg, onProgress, runtime),
    startupPlan: (cfg, selected, profile) => startup.execute(cfg, selected, profile),
    shutdownPlan: (cfg, selected) => shutdown.execute(cfg, selected),
    resolveStartRequest: (cfg, req) => resolveStart.execute(cfg, req),
  };
}

export const defaultTuiWorkspace: TuiWorkspace = createTuiWorkspace();
