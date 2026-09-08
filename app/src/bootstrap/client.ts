import { loadTuiConfig, saveTuiPreferences, resolveTuiOverridePath, userTuiConfigPath } from "../adapters/config/tui-preferences.ts";
import type { ClientRuntime } from "../application/client-runtime.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readPersistedState, bootstrapLogPath, exportsDir } from "../adapters/storage/storage.ts";
import { resolveExportPath, writeLogExport, openInFileManager, listSessions, loadSessionEvents } from "../adapters/storage/logs.ts";
import { freePort } from "../adapters/net/ports.ts";
import { createStarterConfig, runSetup } from "../presentation/cli/setup.ts";
import type { DoctorRunner } from "../ports/doctor-runner.ts";
import { load, loadOrEmpty, loadPath, validate, validateConfigText, discover, configDiff } from "../adapters/config/index.ts";
import { detectGoogle, loginGoogle, logoutGoogle } from "../adapters/google/google.ts";
import { TokenManager, googleTokenProviders } from "../adapters/google/token.ts";
import { createDoctorHost, createDoctorRunner, formatDoctor, type DoctorHost, type DoctorProgress, type DoctorRuntimeContext, type Report } from "../adapters/doctor/doctor.ts";
import { GetShutdownPlan, GetStartupPlan, ResolveStart, RunDoctor } from "../application/commands.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
import { openAttach, openController, openTui, findDaemon, tryDial, assertMethodAllowed } from "../adapters/rpc/controller.ts";

export function createClient(deps?: { doctorRunner?: DoctorRunner; doctorHost?: DoctorHost; tokens?: TokenManager }): ClientRuntime {
  const tokens = deps?.tokens ?? new TokenManager(60_000, googleTokenProviders(), undefined);
  const doctorHost = deps?.doctorHost ?? createDoctorHost({ tokens });
  const client: ClientRuntime = {
    loadTuiConfig, saveTuiPreferences, resolveTuiOverridePath, userTuiConfigPath, listSessions, loadSessionEvents,
    loadPath, validateConfigText, discover, configDiff,
    openTui, findDaemon, tryDial, assertMethodAllowed,
    readPersistedState, bootstrapLogPath, exportsDir, resolveExportPath, writeLogExport, openInFileManager, freePort,
    createStarterConfig,
    runSetup: (startDir, explicitConfig, force) => runSetup(client, startDir, explicitConfig, force),
    readTextFile: (path) => readFileSync(path, "utf8"),
    writeTextFile: (path, text) => writeFileSync(path, text),
    fileExists: existsSync,
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
    openController,
    openAttach,
  };
  return client;
}

export async function doctorReport(
  client: ClientRuntime,
  cfg: DevctlConfig,
  onProgress?: (progress: DoctorProgress) => void,
  runtime?: DoctorRuntimeContext,
): Promise<Report> {
  return client.runDoctor.execute(cfg, onProgress, runtime);
}

export type { ClientRuntime, Controller } from "../application/client-runtime.ts";
