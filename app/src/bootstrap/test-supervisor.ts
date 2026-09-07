import { ServiceOrchestrator } from "../application/orchestrator.ts";
import { ProcessManager } from "../adapters/process/processes.ts";
import { TokenManager } from "../adapters/google/token.ts";
import { systemClock } from "../adapters/system/clock.ts";
import { osFileSystem } from "../adapters/system/filesystem.ts";
import { Bus } from "../shared/events.ts";
import { Supervisor as DaemonSupervisor } from "../adapters/daemon/supervisor.ts";
import { healthCheckerFactory } from "../adapters/health/health.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
export { diffReload } from "../adapters/daemon/supervisor.ts";

/** Integration fixtures use real local processes and fake Google access unless explicitly overridden. */
export class Supervisor extends DaemonSupervisor {
  constructor(cfg: DevctlConfig, deps: Partial<ConstructorParameters<typeof DaemonSupervisor>[1]> = {}) {
    const clock = deps.clock ?? systemClock;
    const bus = deps.bus ?? new Bus(2048);
    const procs = deps.procs ?? new ProcessManager();
    super(cfg, {
      ...deps,
      healthCheckers: deps.healthCheckers ?? healthCheckerFactory([]),
      clock,
      fs: deps.fs ?? osFileSystem,
      bus,
      procs,
      orchestrator: deps.orchestrator ?? new ServiceOrchestrator(procs, clock),
      tokens: deps.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, [], bus, undefined, clock),
      detectGoogle: deps.detectGoogle ?? (async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" })),
    });
  }
}
