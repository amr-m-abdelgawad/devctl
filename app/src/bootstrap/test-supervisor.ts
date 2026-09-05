import { Supervisor as DaemonSupervisor } from "../adapters/daemon/supervisor.ts";
import { healthCheckerFactory } from "../adapters/health/health.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
export { diffReload } from "../adapters/daemon/supervisor.ts";

/** Integration tests opt into real process/health adapters, with per-test overrides. */
export class Supervisor extends DaemonSupervisor {
  constructor(cfg: DevctlConfig, deps: Partial<ConstructorParameters<typeof DaemonSupervisor>[1]> = {}) {
    super(cfg, { healthCheckers: healthCheckerFactory([]), ...deps });
  }
}
