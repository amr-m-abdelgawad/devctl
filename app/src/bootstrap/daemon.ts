import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { healthCheckerFactory } from "../adapters/health/health.ts";
import type { HealthCheckerFactory } from "../ports/health-checker.ts";
import type { DevctlConfig } from "../domain/config/types.ts";
import { Bus } from "../shared/events.ts";
import { ProcessManager, inspectProcess, processAlive } from "../adapters/process/processes.ts";
import { TokenManager, googleTokenProviders } from "../adapters/google/token.ts";
import { systemClock } from "../adapters/system/clock.ts";
import { osFileSystem } from "../adapters/system/filesystem.ts";
import { discover, loadOrEmpty, stopOnExit } from "../adapters/config/index.ts";
import type { Clock } from "../ports/clock.ts";
import type { FileSystem } from "../ports/filesystem.ts";
import { ServiceOrchestrator } from "../application/orchestrator.ts";
import { commandsForHost } from "../application/commands.ts";
import { startEventLoopWatchdog } from "../adapters/daemon/event-loop-watchdog.ts";
import { Supervisor } from "../adapters/daemon/supervisor.ts";
import type { TokenManager as Tokens } from "../adapters/google/token.ts";
import type { ProcessManager as Processes } from "../adapters/process/processes.ts";
import { detectGoogle, type GoogleStatus } from "../adapters/google/google.ts";
import { createDaemonLogStore } from "../adapters/storage/worker-log-store.ts";
import { Detector } from "../adapters/secrets/detector.ts";
import { acquireLock, newSessionID, persistedConfigOverlay } from "../adapters/storage/storage.ts";
import { claimSlot, recordInstancePorts, releaseSlot } from "../adapters/storage/instances.ts";
import { listenerPorts } from "../domain/net/port-slots.ts";
import { createDoctorHost, createDoctorRunner } from "../adapters/doctor/doctor.ts";
import { McpHttpServer } from "../presentation/mcp/server.ts";
import { WebHttpServer } from "../presentation/web/server.ts";
import { githubUpdate } from "../adapters/update/update.ts";
import { isKnownToolName } from "../presentation/mcp/tools.ts";
import type { McpListener, McpListenerFactory } from "../ports/mcp-host.ts";
import type { WebListener, WebListenerFactory } from "../ports/web-host.ts";

export type DaemonDeps = {
  healthCheckers?: HealthCheckerFactory;
  bus?: Bus;
  clock?: Clock;
  fs?: FileSystem;
  processes?: Processes;
  tokens?: Tokens;
  detectGoogle?: (project: string) => Promise<GoogleStatus>;
  createMcpListener?: McpListenerFactory;
  createWebListener?: WebListenerFactory;
};

export type DaemonRuntime = {
  supervisor: Supervisor;
  orchestrator: ServiceOrchestrator;
  clock: Clock;
  fs: FileSystem;
};

export const defaultMcpListener: McpListenerFactory = (opts): McpListener =>
  new McpHttpServer({ host: "127.0.0.1", ...opts });

export const defaultWebListener: WebListenerFactory = (opts): WebListener =>
  new WebHttpServer({ host: "127.0.0.1", checkUpdate: () => githubUpdate().check(), ...opts });

export async function createDaemon(cfg: DevctlConfig, deps: DaemonDeps = {}): Promise<DaemonRuntime> {
  const clock = deps.clock ?? systemClock;
  const fs = deps.fs ?? osFileSystem;
  const processes = deps.processes ?? new ProcessManager();
  const bus = deps.bus ?? new Bus(2048);
  const tokens = deps.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, googleTokenProviders(), bus, undefined, clock);
  const orchestrator = new ServiceOrchestrator(processes, clock);
  const sessionID = newSessionID();
  const detector = new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns, cfg.secrets.redact);
  const standalone = Bun.isStandaloneExecutable === true;
  const { logs, usingWorker } = await createDaemonLogStore(
    {
      max: cfg.logs.max_memory_events,
      persist: cfg.logs.persistence.enabled,
      directory: cfg.logs.persistence.directory,
      sessionID,
      retentionDays: cfg.logs.persistence.retention_days,
      maxSessionLogs: cfg.logs.persistence.max_session_logs,
      extraMarkers: cfg.secrets.extra_markers,
      extraPatterns: cfg.secrets.extra_patterns,
      redact: cfg.secrets.redact,
    },
    bus,
    detector,
    { standalone },
  );
  if (!usingWorker && !standalone) {
    logs.append({
      timestamp: clock.isoNow(),
      service: "devctl",
      source: "devctl",
      level: "WARN",
      message: "log worker failed to start; using in-process log store",
      pid: 0,
    });
  }
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
    createWebListener: deps.createWebListener ?? defaultWebListener,
    isKnownTool: isKnownToolName,
    createCommands: (host) => commandsForHost(host, createDoctorRunner(createDoctorHost({ tokens })), orchestrator),
  });
  return { supervisor, orchestrator, clock, fs };
}

/** Entry used by the CLI’s internal daemon command. */
export async function runDaemon(repoRoot: string, configPath: string): Promise<void> {
  const watchdog = startEventLoopWatchdog();
  // loadOrEmpty, not load: a daemon is only ever spawned because a client
  // already decided one should exist, so a missing configuration here means
  // setup mode (see `devctl mcp --on`), not an error worth dying over. An
  // invalid configuration still throws.
  let overlay: string | undefined;
  let root = resolve(repoRoot);
  try {
    root = discover(repoRoot, configPath).repoRoot;
    overlay = persistedConfigOverlay(root);
  } catch {
    overlay = undefined;
  }
  // Parallel stacks (#117): take this checkout's port slot before loading,
  // so every fixed port and listener is shifted for it. Sticky until a full
  // `down` below (or `devctl instances prune`).
  const slot = claimSlot(root);
  const cfg = loadOrEmpty(repoRoot, configPath, { overlay, slot });
  recordInstancePorts(cfg.repoRoot, listenerPorts(cfg));
  const { supervisor: sup } = await createDaemon(cfg);
  // This daemon normally stops via the "shutdown" RPC (`devctl stop`),
  // but it can also receive a signal directly (system shutdown, an
  // admin `kill`, a container orchestrator). Without a handler, Node's
  // default action skips shutdown() entirely — including flushing the
  // now-asynchronous log writes — so register one as a safety net.
  // Both the shutdown RPC and a signal end here. The watchdog worker (and
  // any handle a subsystem failed to close) would otherwise keep the process
  // alive after the socket is gone, so exit once teardown has finished.
  // Services are spawned detached on every platform, so this holds for
  // `down --keep-services` too: they keep running after this process exits.
  // A teardown failure is reported and exits 1, so `down` never looks clean
  // when cleanup did not finish.
  void sup.stopped.then(({ servicesStopped, failure }) => {
    watchdog.stop();
    // A full stop frees the port slot; with --keep-services the services
    // still run on the slot's ports, so it stays with this checkout.
    if (servicesStopped && failure === undefined) {
      try {
        releaseSlot(cfg.repoRoot);
      } catch {
        // the slot is freed by `devctl instances prune` instead
      }
    }
    if (failure !== undefined) {
      process.stderr.write(`devctl: shutdown failed: ${failure instanceof Error ? failure.message : String(failure)}\n`);
      process.exit(1);
    }
    process.exit(0);
  });
  const onSignal = (): void => {
    sup.shutdown(stopOnExit(cfg.shutdown)).catch(() => undefined);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await sup.run();
}
