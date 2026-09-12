import { existsSync, unlinkSync } from "node:fs";
import { ServiceOrchestrator } from "../application/orchestrator.ts";
import { commandsForHost } from "../application/commands.ts";
import { ProcessManager, inspectProcess, processAlive } from "../adapters/process/processes.ts";
import { TokenManager } from "../adapters/google/token.ts";
import { systemClock } from "../adapters/system/clock.ts";
import { osFileSystem } from "../adapters/system/filesystem.ts";
import { Bus } from "../shared/events.ts";
import { Supervisor as DaemonSupervisor } from "../adapters/daemon/supervisor.ts";
import { healthCheckerFactory } from "../adapters/health/health.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
import { LogManager, inProcessLogStore } from "../adapters/storage/logs.ts";
import { Detector } from "../adapters/secrets/detector.ts";
import { acquireLock, newSessionID } from "../adapters/storage/storage.ts";
import { createDoctorHost, createDoctorRunner } from "../adapters/doctor/doctor.ts";
import { isKnownToolName } from "../presentation/mcp/tools.ts";
import { defaultMcpListener, defaultWebListener } from "./daemon.ts";
export { diffReload } from "../adapters/daemon/supervisor.ts";

/** Integration fixtures use real local processes and fake Google access unless explicitly overridden. */
export class Supervisor extends DaemonSupervisor {
  constructor(cfg: DevctlConfig, deps: Partial<ConstructorParameters<typeof DaemonSupervisor>[1]> = {}) {
    const clock = deps.clock ?? systemClock;
    const bus = deps.bus ?? new Bus(2048);
    const procs = deps.procs ?? new ProcessManager();
    const orchestrator = deps.orchestrator ?? new ServiceOrchestrator(procs, clock);
    const tokens = deps.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, [], bus, undefined, clock);
    const sessionID = deps.sessionID ?? newSessionID();
    const detector = deps.detector ?? new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns);
    const logs = deps.logs ?? inProcessLogStore(new LogManager(
      cfg.logs.max_memory_events,
      bus,
      detector,
      cfg.logs.persistence.enabled,
      cfg.logs.persistence.directory,
      sessionID,
      cfg.logs.persistence.retention_days,
      cfg.logs.persistence.max_session_logs,
    ));
    super(cfg, {
      inspectProcess,
      processAlive,
      acquireLock,
      socketExists: existsSync,
      unlinkSocket: unlinkSync,
      isKnownTool: isKnownToolName,
      ...deps,
      createMcpListener: deps.createMcpListener ?? defaultMcpListener,
      createWebListener: deps.createWebListener ?? defaultWebListener,
      healthCheckers: deps.healthCheckers ?? healthCheckerFactory([]),
      clock,
      fs: deps.fs ?? osFileSystem,
      bus,
      procs,
      orchestrator,
      tokens,
      logs,
      detector,
      sessionID,
      detectGoogle: deps.detectGoogle ?? (async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" })),
      createCommands: deps.createCommands ?? ((host) => commandsForHost(host, createDoctorRunner(createDoctorHost({ tokens })), orchestrator)),
    });
  }
}
