import { existsSync, unlinkSync } from "node:fs";
import { healthCheckerFactory } from "../adapters/health/health.ts";
import type { HealthCheckerFactory } from "../ports/health-checker.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
import { Bus } from "../shared/events.ts";
import { ProcessManager, inspectProcess, processAlive } from "../adapters/process/processes.ts";
import { TokenManager, googleTokenProviders } from "../adapters/google/token.ts";
import { systemClock } from "../adapters/system/clock.ts";
import { osFileSystem } from "../adapters/system/filesystem.ts";
import { load, loadOrEmpty, stopOnExit } from "../adapters/config/index.ts";
import type { ConfigSource } from "../ports/config-source.ts";
import type { Clock } from "../ports/clock.ts";
import type { FileSystem } from "../ports/filesystem.ts";
import { ServiceOrchestrator } from "../application/orchestrator.ts";
import { commandsForHost } from "../application/commands.ts";
import { Supervisor } from "../adapters/daemon/supervisor.ts";
import type { TokenManager as Tokens } from "../adapters/google/token.ts";
import type { ProcessManager as Processes } from "../adapters/process/processes.ts";
import { detectGoogle, type GoogleStatus } from "../adapters/google/google.ts";
import { LogManager } from "../adapters/storage/logs.ts";
import { Detector } from "../adapters/secrets/detector.ts";
import { acquireLock, newSessionID } from "../adapters/storage/storage.ts";
import { createDoctorHost, createDoctorRunner } from "../adapters/doctor/doctor.ts";
import { McpHttpServer } from "../presentation/mcp/server.ts";
import { isKnownToolName } from "../presentation/mcp/tools.ts";
import type { McpListener, McpListenerFactory } from "../ports/mcp-host.ts";

export type DaemonDeps = {
  healthCheckers?: HealthCheckerFactory;
  bus?: Bus;
  clock?: Clock;
  fs?: FileSystem;
  config?: ConfigSource;
  processes?: Processes;
  tokens?: Tokens;
  detectGoogle?: (project: string) => Promise<GoogleStatus>;
  createMcpListener?: McpListenerFactory;
};

export type DaemonRuntime = {
  supervisor: Supervisor;
  orchestrator: ServiceOrchestrator;
  clock: Clock;
  fs: FileSystem;
};

export const defaultMcpListener: McpListenerFactory = (opts): McpListener =>
  new McpHttpServer({ host: "127.0.0.1", ...opts });

export function createDaemon(cfg: DevctlConfig, deps: DaemonDeps = {}): DaemonRuntime {
  const clock = deps.clock ?? systemClock;
  const fs = deps.fs ?? osFileSystem;
  const processes = deps.processes ?? new ProcessManager();
  const bus = deps.bus ?? new Bus(2048);
  const tokens = deps.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, googleTokenProviders(), bus, undefined, clock);
  const orchestrator = new ServiceOrchestrator(processes, clock);
  const sessionID = newSessionID();
  const detector = new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns);
  const logs = new LogManager(
    cfg.logs.max_memory_events,
    bus,
    detector,
    cfg.logs.persistence.enabled,
    cfg.logs.persistence.directory,
    sessionID,
    cfg.logs.persistence.retention_days,
    cfg.logs.persistence.max_session_logs,
  );
  const supervisor = new Supervisor(cfg, {
    healthCheckers: deps.healthCheckers ?? healthCheckerFactory([]),
    detectGoogle: deps.detectGoogle ?? detectGoogle,
    tokens,
    inspectProcess,
    processAlive,
    acquireLock,
    socketExists: existsSync,
    unlinkSocket: unlinkSync,
    procs: processes,
    orchestrator,
    clock,
    fs,
    bus,
    logs,
    detector,
    sessionID,
    createMcpListener: deps.createMcpListener ?? defaultMcpListener,
    isKnownTool: isKnownToolName,
    createCommands: (host) => commandsForHost(host, createDoctorRunner(createDoctorHost({ tokens })), orchestrator),
  });
  return { supervisor, orchestrator, clock, fs };
}

export function loadDaemonConfig(repoRoot: string, configPath: string, source: ConfigSource = { load }): DevctlConfig {
  return source.load(repoRoot, configPath);
}

/** Entry used by the CLI’s internal daemon command. */
export async function runDaemon(repoRoot: string, configPath: string): Promise<void> {
  // loadOrEmpty, not load: a daemon is only ever spawned because a client
  // already decided one should exist, so a missing configuration here means
  // setup mode (see `devctl mcp --on`), not an error worth dying over. An
  // invalid configuration still throws.
  const cfg = loadOrEmpty(repoRoot, configPath);
  const { supervisor: sup } = createDaemon(cfg);
  // This daemon normally stops via the "shutdown" RPC (`devctl stop`),
  // but it can also receive a signal directly (system shutdown, an
  // admin `kill`, a container orchestrator). Without a handler, Node's
  // default action skips shutdown() entirely — including flushing the
  // now-asynchronous log writes — so register one as a safety net.
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void sup.shutdown(stopOnExit(cfg.shutdown)).finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await sup.run();
}
