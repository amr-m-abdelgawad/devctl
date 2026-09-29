import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { installCrashHandlers, updateCrashHooks } from "../adapters/daemon/crash.ts";
import { autoRingBytes, configuredByteCap, DEFAULT_LOG_CAP_BYTES, DEFAULT_LOG_TOTAL_BYTES } from "../domain/logs/budgets.ts";
import { readHostLimits } from "../adapters/system/host-limits.ts";
import { enableChildSubreaper, reapOrphanedChildren } from "../adapters/process/subreaper.ts";
import { claimRestartRequest, clearRestartRequest, daemonStateDir } from "../adapters/daemon/heartbeat.ts";
import { noteEventLoopLag } from "../adapters/daemon/resource-probe.ts";
import { Supervisor } from "../adapters/daemon/supervisor.ts";
import type { TokenManager as Tokens } from "../adapters/google/token.ts";
import type { ProcessManager as Processes } from "../adapters/process/processes.ts";
import { detectGoogle, type GoogleStatus } from "../adapters/google/google.ts";
import { createDaemonLogStore } from "../adapters/storage/worker-log-store.ts";
import { Detector } from "../adapters/secrets/detector.ts";
import { acquireLock, newSessionID, persistedConfigOverlay, socketPath, bootstrapLogPath, repoID } from "../adapters/storage/storage.ts";
import { recordInstancePorts, releaseSlot, startWithSlot } from "../adapters/storage/instances.ts";
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
  detectGoogle?: (project: string, repoRoot?: string) => Promise<GoogleStatus>;
  createMcpListener?: McpListenerFactory;
  createWebListener?: WebListenerFactory;
  heldLock?: { release: () => void };
};

export type DaemonRuntime = {
  supervisor: Supervisor;
  orchestrator: ServiceOrchestrator;
  clock: Clock;
  fs: FileSystem;
  sessionID: string;
};

export const defaultMcpListener: McpListenerFactory = (opts): McpListener =>
  new McpHttpServer({ host: "127.0.0.1", ...opts });

export const defaultWebListener: WebListenerFactory = (opts): WebListener =>
  new WebHttpServer({ host: "127.0.0.1", checkUpdate: () => githubUpdate().check(), ...opts });

export async function createDaemon(cfg: DevctlConfig, deps: DaemonDeps = {}): Promise<DaemonRuntime> {
  const clock = deps.clock ?? systemClock;
  const fs = deps.fs ?? osFileSystem;
  const processes = deps.processes ?? new ProcessManager({
    stdioRoot: process.platform === "win32" ? undefined : join(daemonStateDir(cfg.repoRoot), "stdio"),
    spoolMaxBytes: configuredByteCap(cfg.logs.spool.max_bytes, DEFAULT_LOG_CAP_BYTES),
  });
  const bus = deps.bus ?? new Bus(2048);
  const tokens = deps.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, googleTokenProviders(), bus, undefined, clock);
  const orchestrator = new ServiceOrchestrator(processes, clock);
  const sessionID = newSessionID();
  const detector = new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns, cfg.secrets.redact);
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
      repoKey: repoID(cfg.repoRoot),
      maxMemoryBytes: cfg.logs.max_memory_bytes > 0 ? cfg.logs.max_memory_bytes : autoRingBytes(readHostLimits(cfg.repoRoot).memoryBytes),
      maxSessionBytes: configuredByteCap(cfg.logs.persistence.max_session_bytes, DEFAULT_LOG_CAP_BYTES),
      maxSpoolBytes: configuredByteCap(cfg.logs.spool.max_bytes, DEFAULT_LOG_CAP_BYTES),
      maxTotalBytes: configuredByteCap(cfg.logs.persistence.max_total_bytes, DEFAULT_LOG_TOTAL_BYTES),
      spoolDir: join(daemonStateDir(cfg.repoRoot), "log-spool"),
    },
    bus,
    detector,
  );
  if (!usingWorker) {
    logs.append({
      timestamp: clock.isoNow(),
      service: "devctl",
      source: "devctl",
      level: "WARN",
      message: "log worker failed to start; using in-process log store",
      pid: 0,
    });
  }
  const held = deps.heldLock;
  const supervisor = new Supervisor(cfg, {
    healthCheckers: deps.healthCheckers ?? healthCheckerFactory([]),
    detectGoogle: deps.detectGoogle ?? detectGoogle,
    tokens,
    inspectProcess,
    processAlive,
    acquireLock: held ? () => held : acquireLock,
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
  return { supervisor, orchestrator, clock, fs, sessionID };
}

/** Entry used by the CLI’s internal daemon command. */
export async function runDaemon(repoRoot: string, configPath: string): Promise<void> {
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
  // Take the lock before the log store is built, pruned, or replayed.
  const held = acquireLock(root, socketPath(root));
  // A request written before this daemon held the lock was meant for a
  // predecessor; acting on it would stop this daemon right after it starts.
  clearRestartRequest(root);
  installCrashHandlers({
    logPath: bootstrapLogPath(root),
    flush: async () => undefined,
    release: () => held.release(),
    record: (message) => {
      process.stderr.write(`devctl: ${message}\n`);
    },
  });
  let watchdog: ReturnType<typeof startEventLoopWatchdog> | undefined;
  try {
    const { cfg, supervisor: sup, sessionID } = await startWithSlot(root, async (slot) => {
      const loaded = loadOrEmpty(repoRoot, configPath, { overlay, slot });
      recordInstancePorts(loaded.repoRoot, listenerPorts(loaded));
      return { cfg: loaded, ...(await createDaemon(loaded, { heldLock: held })) };
    });
    watchdog = startEventLoopWatchdog({
      repoRoot: cfg.repoRoot,
      session: sessionID,
      identity: String(process.pid),
    });
    watchdog.noteRestartRequest(() => {
      sup.shutdown(false).catch(() => undefined);
    });
    const limits = readHostLimits(cfg.repoRoot);
    if (limits.nonReapingPid1) {
      process.stderr.write("devctl: PID 1 does not reap child processes. Set supervisor.reap_orphans: true or run under an init that reaps.\n");
    }
    if (cfg.supervisor.reap_orphans) {
      void enableChildSubreaper();
    }
    updateCrashHooks({
      flush: () => sup.flushLogs(),
      record: (message) => {
        process.stderr.write(`devctl: ${message}\n`);
        sup.recordCrash(message);
      },
    });
    const guard = setInterval(() => {
      const usage = process.memoryUsage().rss;
      const host = readHostLimits(cfg.repoRoot);
      sup.applyMemoryPressure(usage, host.memoryBytes);
      if (cfg.supervisor.reap_orphans) {
        void reapOrphanedChildren(sup.servicePids());
      }
      const mark = Date.now();
      setImmediate(() => {
        noteEventLoopLag(Date.now() - mark);
      });
    }, 1_000);
    guard.unref?.();
    void sup.stopped.then(({ servicesStopped, failure }) => {
      clearInterval(guard);
      watchdog?.stop();
      let failed = failure;
      if (servicesStopped && failed === undefined) {
        try {
          releaseSlot(cfg.repoRoot);
        } catch (err) {
          failed = new Error(`could not free port slot ${cfg.instance.slot}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failed !== undefined) {
        process.stderr.write(`devctl: shutdown failed: ${failed instanceof Error ? failed.message : String(failed)}\n`);
        process.exit(1);
      }
      process.exit(0);
    });
    const onSignal = (): void => {
      // A client replacing this daemon as wedged asks for a hand-off before
      // it sends SIGTERM. If the loop recovers in time, the services keep
      // running for the next daemon to adopt.
      const handOff = claimRestartRequest(cfg.repoRoot, { pid: process.pid, session: sessionID });
      sup.shutdown(handOff ? false : stopOnExit(cfg.shutdown)).catch(() => undefined);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    await sup.run();
    watchdog.markListening();
  } catch (err) {
    watchdog?.stop();
    held.release();
    throw err;
  }
}
