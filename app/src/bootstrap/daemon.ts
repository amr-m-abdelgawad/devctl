import { healthCheckerFactory } from "../adapters/health/health.ts";
import type { HealthCheckerFactory } from "../ports/health-checker.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
import { Bus } from "../shared/events.ts";
import { ProcessManager } from "../adapters/process/processes.ts";
import { TokenManager, googleTokenProviders } from "../adapters/google/token.ts";
import { systemClock } from "../adapters/system/clock.ts";
import { osFileSystem } from "../adapters/system/filesystem.ts";
import { load } from "../adapters/config/index.ts";
import type { ConfigSource } from "../ports/config-source.ts";
import type { Clock } from "../ports/clock.ts";
import type { FileSystem } from "../ports/filesystem.ts";
import { ServiceOrchestrator } from "../application/orchestrator.ts";
import { Supervisor } from "../adapters/daemon/supervisor.ts";
import type { TokenManager as Tokens } from "../adapters/google/token.ts";
import type { ProcessManager as Processes } from "../adapters/process/processes.ts";
import { detectGoogle, type GoogleStatus } from "../adapters/google/google.ts";

export type DaemonDeps = {
  healthCheckers?: HealthCheckerFactory;
  clock?: Clock;
  fs?: FileSystem;
  config?: ConfigSource;
  processes?: Processes;
  tokens?: Tokens;
  detectGoogle?: (project: string) => Promise<GoogleStatus>;
};

export type DaemonRuntime = {
  supervisor: Supervisor;
  orchestrator: ServiceOrchestrator;
  clock: Clock;
  fs: FileSystem;
};

export function createDaemon(cfg: DevctlConfig, deps: DaemonDeps = {}): DaemonRuntime {
  const clock = deps.clock ?? systemClock;
  const fs = deps.fs ?? osFileSystem;
  const processes = deps.processes ?? new ProcessManager();
  const bus = new Bus(2048);
  const tokens = deps.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, googleTokenProviders(), bus);
  const orchestrator = new ServiceOrchestrator(processes, clock);
  const supervisor = new Supervisor(cfg, {
    healthCheckers: deps.healthCheckers ?? healthCheckerFactory([]),
    detectGoogle: deps.detectGoogle ?? detectGoogle,
    tokens,
    procs: processes,
    orchestrator,
    clock,
    fs,
    bus,
  });
  return { supervisor, orchestrator, clock, fs };
}

export function loadDaemonConfig(repoRoot: string, configPath: string, source: ConfigSource = { load }): DevctlConfig {
  return source.load(repoRoot, configPath);
}
