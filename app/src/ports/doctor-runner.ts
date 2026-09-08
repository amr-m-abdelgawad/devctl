import type { DevctlConfig } from "../domain/config/types.ts";
import type { DoctorProgress, DoctorRuntimeContext, Report } from "../domain/doctor/types.ts";

/** Runs environment diagnostics without exposing infrastructure to commands. */
export type DoctorRunner = {
  run(cfg: DevctlConfig, onProgress?: (progress: DoctorProgress) => void, runtime?: DoctorRuntimeContext): Promise<Report>;
};
