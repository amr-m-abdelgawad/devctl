import type { DoctorRunner } from "../ports/doctor-runner.ts";
import { load, loadOrEmpty, validate } from "../adapters/config/index.ts";
import { detectGoogle, loginGoogle, logoutGoogle, type GoogleStatus } from "../adapters/google/google.ts";
import { TokenManager, googleTokenProviders } from "../adapters/google/token.ts";
import { createDoctorHost, createDoctorRunner, formatDoctor, type DoctorHost, type DoctorProgress, type DoctorRuntimeContext, type Report } from "../adapters/doctor/doctor.ts";
import { GetShutdownPlan, GetStartupPlan, ResolveStart, RunDoctor } from "../application/commands.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
import { openAttach, openController, type Controller } from "../adapters/rpc/controller.ts";

export type ClientRuntime = {
  load: typeof load;
  loadOrEmpty: typeof loadOrEmpty;
  validate: typeof validate;
  detectGoogle: (project: string) => Promise<GoogleStatus>;
  loginGoogle: typeof loginGoogle;
  logoutGoogle: typeof logoutGoogle;
  refreshUserToken: (identity?: string) => Promise<{ identity: string; expiresAt: Date }>;
  runDoctor: RunDoctor;
  getStartupPlan: GetStartupPlan;
  getShutdownPlan: GetShutdownPlan;
  resolveStart: ResolveStart;
  formatDoctor: typeof formatDoctor;
  doctorHost: DoctorHost;
  openController: typeof openController;
  openAttach: typeof openAttach;
};

export function createClient(deps?: { doctorRunner?: DoctorRunner; doctorHost?: DoctorHost; tokens?: TokenManager }): ClientRuntime {
  const tokens = deps?.tokens ?? new TokenManager(60_000, googleTokenProviders(), undefined);
  const doctorHost = deps?.doctorHost ?? createDoctorHost({ tokens });
  return {
    load,
    loadOrEmpty,
    validate,
    detectGoogle,
    loginGoogle,
    logoutGoogle,
    refreshUserToken: async (identity = "user") => tokens.refresh(identity, "", []),
    runDoctor: new RunDoctor(deps?.doctorRunner ?? createDoctorRunner(doctorHost)),
    getStartupPlan: new GetStartupPlan(),
    getShutdownPlan: new GetShutdownPlan(),
    resolveStart: new ResolveStart(),
    formatDoctor,
    doctorHost,
    openController,
    openAttach,
  };
}

export async function doctorReport(
  client: ClientRuntime,
  cfg: DevctlConfig,
  onProgress?: (progress: DoctorProgress) => void,
  runtime?: DoctorRuntimeContext,
): Promise<Report> {
  return client.runDoctor.execute(cfg, onProgress, runtime);
}

export type { Controller };
